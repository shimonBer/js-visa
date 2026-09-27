/**
 * DS-160 Deterministic Page Matcher
 *
 * matchPage() maps the live field inventory onto the applicant's answers with
 * no network call, emitting the same action shape planPage() produces so
 * executeAction handles both identically.
 *
 * Per field the value is resolved in this order:
 *   1. the canonical field id from the ds160-fields registry, which an answer
 *      sheet generated from that registry keys on exactly
 *   2. the registry's prose aliases for the field
 *   3. the selector regexes already curated in agent.js (DS160_KNOWN /
 *      DS160_KNOWN_RADIOS), inverted from selector → question pattern
 *   4. the field's own DOM label, but only when it matches exactly one answer
 *
 * Anything left unresolved is reported so the caller can decide whether to
 * hand the page to the LLM planner.
 */

import { ceacNameNeedsRewrite, isCeacNameField, sanitizeCeacName } from '../lib/ceacNameFormatting.js'
import { normalizePhoneFillValue } from '../lib/phoneFormatting.js'
import {
  DS160_KNOWN,
  DS160_KNOWN_RADIOS,
  parsePackedUsAddress,
  parseSocialMediaFromSource,
  sourceUsedSocialMedia,
} from './agent.js'
import { DS160_UNKNOWN_CHECKBOXES, controlName, fieldsByRef, isMarkerValue } from './ds160-fields.js'

/**
 * Page contexts whose field↔answer mapping has been verified against DOM
 * snapshots. "security" carries no registry entries — its questions are all
 * radios resolved from the curated question patterns in agent.js.
 */
export const MATCHER_PAGES = new Set([
  'personal1', 'personal2', 'address', 'passport', 'contact', 'family', 'spouse', 'security',
  'travel', 'companions', 'prev_travel', 'work_present', 'work_previous', 'work_additional', 'work_edu',
])

// ─── Text normalization ──────────────────────────────────────────────────────

/** Lower-case alphanumeric tokens; makes "Father’s Surname" == "Father's Surname". */
export function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * "N/A" style answers that mean "check the Does Not Apply box", not "type this".
 * A bare "No"/"Nope" is included here — unlike in isMarkerValue — because on
 * this side the value has already been matched to a specific field, so there is
 * no risk of mistaking the surname "No" for a refusal.
 */
const NA_MARKER_RE = /^(?:no|nope)$/i

/** Data the translator could not find — never typed, never converted to a checkbox. */
const MISSING_RE = /missing/i

/** Select placeholders ("- Select One -", "PLEASE SELECT A VISA CLASS"). */
const PLACEHOLDER_RE = /^(?:[-\s]*select\s*(?:one|a\b.*)?[-\s]*|please\s+select.*)$/i

function isPlaceholder(value) {
  const text = String(value ?? '').trim()
  return !text || PLACEHOLDER_RE.test(text)
}

/** True when the control already holds a real (non-placeholder) value. */
export function isFieldFilled(field) {
  const value = String(field.value ?? '').trim()
  if (!value) return false
  if (field.kind === 'select' || field.kind === 'select-large') return !isPlaceholder(value)
  return true
}

/** Quantity + unit that CEAC only renders after "specific travel plans" = No. */
export function isIntendedStayLengthField(field) {
  return /tbxTRAVEL_LOS$|ddlTRAVEL_LOS_CD$|(?:intended\s+)?length of stay/i.test(
    `${field?.ref || ''} ${field?.label || ''}`,
  )
}

/**
 * Fields a postback just revealed that still need a value.
 *
 * CEAC often omits a nearby validator on intended length of stay until after
 * Next fails, so `required` is not a reliable gate here.
 */
export function revealedFieldsToFill(added = [], plannedRefs = []) {
  const planned = new Set(plannedRefs)
  return added.filter((field) => {
    if (!field || planned.has(field.ref) || field.disabled) return false
    if (field.kind === 'checkbox') return false
    return !isFieldFilled(field)
  })
}

// ─── Source answer parsing ───────────────────────────────────────────────────

/**
 * Parse the translated section into ordered { key, value } entries.
 *
 * Two line shapes appear in the translated documents:
 *   "Field Label: value"      → split on the colon
 *   "Question text? Yes"      → split on the question mark
 * A colon that comes before any "?" wins, so URLs containing "?" stay intact.
 *
 * @param {string} text
 * @returns {{key: string, normKey: string, value: string}[]}
 */
export function parseSourceAnswers(text) {
  const entries = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('🟦')) continue

    const colon = line.indexOf(':')
    const question = line.indexOf('?')
    let key = ''
    let value = ''

    if (colon > 0 && (question < 0 || colon < question)) {
      key = line.slice(0, colon)
      value = line.slice(colon + 1)
    } else if (question > 0) {
      key = line.slice(0, question + 1)
      value = line.slice(question + 1)
    } else {
      continue
    }

    key = key.trim()
    value = value.trim()
    if (!key || !value) continue
    entries.push({ key, normKey: normalizeKey(key), value })
  }
  return entries
}

/**
 * Flatten an answer-sheet section into the same entry shape as the prose parser.
 * Nested objects are walked; arrays contribute one entry per item so repeat rows
 * can be indexed by occurrence.
 */
export function flattenAnswerSheet(section) {
  const entries = []

  const push = (key, value) => {
    if (value === undefined) return
    entries.push({ key, normKey: normalizeKey(key), value })
  }

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') walk(item)
          else push(key, item)
        }
      } else if (value && typeof value === 'object') {
        walk(value)
      } else {
        push(key, value)
      }
    }
  }

  walk(section)
  return entries
}

// ─── Control name → source label map ─────────────────────────────────────────

/**
 * Strip the ASP.NET repeater infix so every row of a repeated control shares one
 * key: "dlUSRelatives_ctl00_tbxUS_REL_SURNAME" → "tbxUS_REL_SURNAME".
 */
export const refCore = controlName


// ─── Inverted agent.js selector regexes ──────────────────────────────────────

let invertedCache = null

function extractSelectorIds(selector) {
  const ids = []
  const pattern = /id(?:\$|\*|\^)?=\s*"([^"]+)"/g
  let match
  while ((match = pattern.exec(String(selector ?? ''))) !== null) {
    const id = match[1].trim()
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Invert the curated selector tables in agent.js into control name → question
 * patterns, so the matcher reuses the same label regexes executeAction trusts.
 * Built lazily: agent.js imports this module, so nothing may run at load time.
 */
function invertedPatterns() {
  if (invertedCache) return invertedCache

  const byControl = new Map()
  const add = (id, regex) => {
    if (!id || !regex) return
    const key = refCore(id)
    if (!byControl.has(key)) byControl.set(key, [])
    byControl.get(key).push(regex)
  }

  for (const entry of DS160_KNOWN_RADIOS || []) {
    const selectors = [...(entry.yesSelectors || []), ...(entry.noSelectors || [])]
    for (const selector of selectors) {
      for (const id of extractSelectorIds(selector)) {
        add(id.replace(/_[01]$/, ''), entry.match)
      }
    }
  }

  for (const entry of DS160_KNOWN || []) {
    for (const id of extractSelectorIds(entry.sel)) {
      add(id, entry.match)
    }
  }

  invertedCache = byControl
  return byControl
}

// ─── Value coercion ──────────────────────────────────────────────────────────

function yesNo(value) {
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  const text = String(value ?? '').trim()
  if (/^y(?:es)?$/i.test(text)) return 'Yes'
  if (/^n(?:o)?$/i.test(text)) return 'No'
  return null
}

/**
 * True when the security section has Yes/No answers and every one of them is No.
 * A missing section is not "all No" — there is nothing to trust.
 */
export function securityAnswersAreAllNo(answers, answerSheet) {
  const verdicts = []
  for (const entry of [...parseSourceAnswers(answers), ...flattenAnswerSheet(answerSheet)]) {
    const verdict = yesNo(entry.value)
    if (verdict) verdicts.push(verdict)
  }
  return verdicts.length > 0 && verdicts.every((verdict) => verdict === 'No')
}

/** A country list ("Georgia") still means Yes on the "have you traveled" radio. */
function radioAnswer(field, value) {
  const answer = yesNo(value)
  if (answer) return answer
  const core = refCore(field.ref)
  if (/COUNTRIES_VISITED_IND/i.test(core) && String(value ?? '').trim() && !isMarker(value)) {
    return 'Yes'
  }
  return null
}

function isMarker(value) {
  if (value === null) return true
  const text = String(value ?? '').trim()
  // An empty answer is not a refusal: the field stays unresolved so the planner
  // can decide, rather than being silently marked as not applicable here.
  if (!text) return false
  // isMarkerValue owns the shared "not applicable" vocabulary, so both the
  // matcher and executeAction treat "Not Relevant" and `✅ Check "Does Not
  // Apply"` the same way a plain "N/A" is treated.
  return isMarkerValue(text) || NA_MARKER_RE.test(text)
}

function isMissing(value) {
  const text = String(value ?? '')
  return text.includes('❗') || (MISSING_RE.test(text) && text.trim().length < 20)
}

const MONTH_ABBREVS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * Normalize a date to the DD/MM/YYYY that executeAction splits into Day, Month
 * and Year.
 *
 * ISO (YYYY-MM-DD) is the canonical input because it is the only one of the
 * three that cannot be read two ways — "03/04/1990" is a real ambiguity that
 * silently files the wrong date, so a slash date is only trusted when the
 * source already claims DD/MM/YYYY.
 */
function normalizeDate(value) {
  const text = String(value ?? '').trim()

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`

  // The DS-160's own display format, which review documents tend to echo.
  const spelled = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})$/)
  if (spelled) {
    const month = MONTH_ABBREVS.indexOf(spelled[2].toUpperCase()) + 1
    if (month) {
      return `${spelled[1].padStart(2, '0')}/${String(month).padStart(2, '0')}/${spelled[3]}`
    }
  }

  return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text) ? text : null
}

const COUNTRY_DEMONYMS = {
  israeli: 'Israel',
  american: 'United States',
  british: 'United Kingdom',
  english: 'United Kingdom',
  french: 'France',
  german: 'Germany',
  spanish: 'Spain',
  italian: 'Italy',
  russian: 'Russia',
  ukrainian: 'Ukraine',
  moroccan: 'Morocco',
  egyptian: 'Egypt',
  turkish: 'Turkey',
  chinese: 'China',
  japanese: 'Japan',
  canadian: 'Canada',
  mexican: 'Mexico',
  brazilian: 'Brazil',
  polish: 'Poland',
  dutch: 'Netherlands',
  irish: 'Ireland',
  indian: 'India',
  lebanese: 'Lebanon',
  jordanian: 'Jordan',
  australian: 'Australia',
}

/** "Israeli" → "Israel" so country dropdowns match DS-160 option text. */
export function normalizeCountryName(value) {
  const text = String(value ?? '').trim()
  if (!text) return text
  return COUNTRY_DEMONYMS[text.toLowerCase()] || text
}

function looksLikeCountryField(field) {
  if (field?.kind === 'select-large') return true
  const blob = `${field?.label || ''} ${refCore(field?.ref)}`
  return /country|nationality|natl|pob_cntry|issued_cntry/i.test(blob)
}

/** Pick the option whose visible text matches, mirroring executeAction's CI scan. */
function resolveOption(field, value) {
  const text = normalizeCountryName(String(value ?? '').trim())
  if (!text) return null
  // Large selects (countries, states) ship without options; executeAction does a
  // case-insensitive scan and falls back to the option value ("FL" → FLORIDA).
  if (!field.options) return text

  const candidates = field.options
    .map((option) => (option.text || option.value || '').trim())
    .filter((option) => option && !isPlaceholder(option))

  const lower = text.toLowerCase()
  return (
    candidates.find((option) => option.toLowerCase() === lower) ||
    candidates.find((option) => {
      const optionLower = option.toLowerCase()
      return optionLower.startsWith(`${lower}/`) || optionLower.startsWith(`${lower} `)
    }) ||
    candidates.find((option) => lower.startsWith(option.toLowerCase())) ||
    null
  )
}

const STAY_UNITS = [
  [/year/i, 'Year(s)'],
  [/month/i, 'Month(s)'],
  [/week/i, 'Week(s)'],
  [/hour/i, 'Less Than 24 Hours'],
  [/day/i, 'Day(s)'],
]

function visaClassPurpose(value) {
  const text = String(value ?? '')
  if (/b\s*1\s*\/?\s*b\s*2|tourism\s*&\s*business|business or pleasure/i.test(text)) {
    return 'TEMP. BUSINESS OR PLEASURE VISITOR (B)'
  }
  return text
}

function visaClassSpecify(value) {
  const text = String(value ?? '')
  if (/b\s*1\s*\/?\s*b\s*2|tourism|business or tourism/i.test(text)) {
    return 'BUSINESS OR TOURISM (TEMPORARY VISITOR) (B1/B2)'
  }
  return text
}

/** Control-specific rewrites applied before the generic per-kind conversion. */
const VALUE_TRANSFORMS = {
  ddlPurposeOfTrip: visaClassPurpose,
  ddlOtherPurpose: visaClassSpecify,
  tbxTRAVEL_LOS: (value) => String(value).match(/\d+/)?.[0] ?? null,
  ddlTRAVEL_LOS_CD: (value) => STAY_UNITS.find(([re]) => re.test(String(value)))?.[1] ?? null,
  // The U.S. contact section packs the whole address onto one line; line 1 is
  // maxlength-limited, so keep only the street part.
  tbxUS_POC_ADDR_LN1: (value) => parsePackedUsAddress(value).street || null,
}

function coerceFieldValue(field, value) {
  const core = refCore(field.ref)
  if (VALUE_TRANSFORMS[core]) return VALUE_TRANSFORMS[core](value)
  const label = `${field.label || ''} ${core}`
  if (looksLikeCountryField(field)) return normalizeCountryName(value)
  if (field.kind === 'select' && /length of stay|travel_los_cd/i.test(label)) {
    return STAY_UNITS.find(([re]) => re.test(String(value)))?.[1] ?? value
  }
  if (field.kind === 'text' && /length of stay|tbxTRAVEL_LOS/i.test(label)) {
    return String(value).match(/\d+/)?.[0] ?? value
  }
  const named = sanitizeCeacNameFill(field, value)
  if (named !== value) return named
  return normalizePhoneFillValue(value, {
    label: field.label,
    ref: field.ref,
    key: field.id,
  })
}

function sanitizeCeacNameFill(field, value) {
  if (typeof value !== 'string') return value
  if (!isCeacNameField({ label: field.label, ref: field.ref })) return value
  return sanitizeCeacName(value)
}

// ─── Answer lookup ───────────────────────────────────────────────────────────

function findEntries(entries, candidate) {
  if (candidate instanceof RegExp) {
    return entries.filter((entry) => candidate.test(entry.key))
  }
  const norm = normalizeKey(candidate)
  if (!norm) return []
  return entries.filter((entry) => entry.normKey === norm)
}

/** When a required country has N/A and no Does-Not-Apply box, reuse a related answer. */
const COUNTRY_FALLBACKS = {
  ddlSpousePOBCountry: [
    'Spouse Nationality',
    'spouse_nationality',
    "Spouse's Country/Region of Origin (Nationality)",
  ],
  ddlSpouseNatDropDownList: [
    'spouse_nationality',
    'Nationality',
    'nationality',
    'Country of Birth',
    'country_of_birth',
  ],
}

function lookupCountryFallback(field, sources) {
  const keys = COUNTRY_FALLBACKS[refCore(field.ref)] || [
    'Spouse Nationality',
    'spouse_nationality',
    'Nationality',
    'nationality',
  ]
  for (const candidate of keys) {
    for (const entries of sources) {
      const hit = findEntries(entries, candidate)[0]
      if (!hit) continue
      if (isMissing(hit.value) || isMarker(hit.value)) continue
      return hit.value
    }
  }
  return null
}

/**
 * Resolve one field to a raw source value.
 * Returns { value, sourceLabel, entry } or null when nothing matched.
 */
function lookupValue(field, sources, registry) {
  const core = refCore(field.ref)
  const row = field.row || 1

  const pick = (matches) => {
    if (!matches.length) return null
    return matches.length >= row ? matches[row - 1] : null
  }

  const entry = registry.get(core)
  // The canonical id comes first: an answer sheet generated from the registry
  // keys on it, which is an exact match rather than a label guess.
  const candidates = [
    ...(entry ? [entry.id, ...(entry.aliases || [])] : []),
    ...(invertedPatterns().get(core) || []),
  ]

  // A trusted candidate may legitimately match several lines (one per repeat
  // row), so index them by occurrence.
  for (const candidate of candidates) {
    for (const entries of sources) {
      const hit = pick(findEntries(entries, candidate))
      if (hit) return { value: hit.value, sourceLabel: hit.key, entry }
    }
  }

  // Last resort: the field's own DOM label. Generic labels ("City", "Surnames")
  // repeat across sections, so only accept an unambiguous match. Previous-employer
  // city must not take the school's "City:" line — that field has a specific alias.
  const skipGenericCity = entry?.id === 'employer_city' || /tbxEmpCity$/i.test(core)
  if (field.label && !skipGenericCity) {
    for (const entries of sources) {
      const matches = findEntries(entries, field.label)
      if (field.row ? matches.length >= field.row : matches.length === 1) {
        const hit = pick(matches)
        if (hit) return { value: hit.value, sourceLabel: hit.key, entry }
      }
    }
  }

  return null
}

// ─── Does Not Apply handling ─────────────────────────────────────────────────

/**
 * Normalize a control name for "does this checkbox gate this field?" comparison.
 * page-inventory's proximity search sometimes links a neighbouring field's
 * checkbox (ddlAPP_POB_CNTRY → cbexAPP_POB_ST_PROVINCE_NA), which must not be
 * checked on the country field's behalf.
 */
function gateCore(ref) {
  return refCore(ref)
    .toUpperCase()
    .replace(/^(?:TBX|DDL|CBEX|CBX|RBL|TB)/, '')
    .replace(/_/g, '')
    .replace(/(?:NAIND|UNKIND|UNK|NA)$/, '')
}

function dnaBelongsToField(field) {
  if (!field.dnaCbxRef) return false
  // CEAC uses one checkbox for both contact-person name inputs. The cores
  // (USPOCSURNAME vs USPOCNAME) do not prefix-match, so the generic test
  // below would skip the box and leave the names blank.
  if (
    /US_POC_NAME_NA/i.test(field.dnaCbxRef) &&
    /US_POC_(SURNAME|GIVEN_NAME)/i.test(field.ref || '')
  ) {
    return true
  }
  const fieldCore = gateCore(field.ref)
  const checkboxCore = gateCore(field.dnaCbxRef)
  if (!fieldCore || !checkboxCore) return false
  return fieldCore.startsWith(checkboxCore) || checkboxCore.startsWith(fieldCore)
}

function dnaLabelFor(ref, inventory) {
  const known = inventory.fields.find((field) => field.ref === ref)
  if (known?.label) return known.label
  return /UNK|_NA_IND$/i.test(String(ref)) ? 'Do Not Know' : 'Does Not Apply'
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Build the action queue for the current page from applicant data alone.
 *
 * @param {object} opts
 * @param {string} opts.pageContext
 * @param {object} opts.inventory        result of extractPageInventory()
 * @param {string} opts.answers          section-filtered translated text
 * @param {object} [opts.answerSheet]    answerSheet[pageContext], when available
 * @returns {{
 *   actions: object[],
 *   nextClick: object | null,
 *   resolvedRefs: string[],
 *   unresolvedRequired: object[],
 * }}
 */
export function matchPage({ pageContext, inventory, answers, answerSheet }) {
  const registry = fieldsByRef(pageContext)
  const unknownCheckboxes = DS160_UNKNOWN_CHECKBOXES[pageContext] || {}
  // Checkbox ref → the canonical field it stands in for, so an "N/A" answer for
  // a parent's date of birth can tick the only control the form offers.
  const checkboxStandIns = new Map()
  for (const [id, cbxRef] of Object.entries(unknownCheckboxes)) {
    const owner = [...registry.values()].find((candidate) => candidate.id === id)
    if (owner) checkboxStandIns.set(cbxRef, owner)
  }

  const sheetEntries = flattenAnswerSheet(answerSheet)
  // Prose first, then the answer sheet: the prose carries the applicant's own
  // wording, and the sheet is the gap-filler.
  const sources = [parseSourceAnswers(answers)]
  if (sheetEntries.length) sources.push(sheetEntries)

  const actions = []
  const resolvedRefs = new Set()
  const checkedDna = new Set()
  const unresolvedRequired = []
  const allSecurityNo = pageContext === 'security' && securityAnswersAreAllNo(answers, answerSheet)

  const pushAction = (action, field) => {
    actions.push(action)
    const postsBack =
      field?.triggersPostback ||
      /cbxUS_POC_NAME_NA|cbxUS_POC_ORG_NA/i.test(action.ref || '')
    if (postsBack) actions.push({ type: 'wait' })
  }

  for (const field of inventory.fields) {
    if (field.disabled) continue
    // Already covered — e.g. one "Does Not Apply" box gates all three SSN inputs.
    if (resolvedRefs.has(field.ref)) continue

    if (isFieldFilled(field)) {
      const dirtyName =
        isCeacNameField({ label: field.label, ref: field.ref }) &&
        ceacNameNeedsRewrite(field.value)
      if (!dirtyName) {
        resolvedRefs.add(field.ref)
        continue
      }
    }

    // All-No security pages are five screens of radios. Click No on every one
    // instead of failing a question the source never named.
    if (allSecurityNo && field.kind === 'radio') {
      resolvedRefs.add(field.ref)
      if (!/^no$/i.test(String(field.value || ''))) {
        pushAction(
          {
            type: 'radio',
            label: field.label || field.ref,
            value: 'No',
            ref: field.ref,
          },
          field,
        )
      }
      continue
    }

    // Checkboxes are opt-in: only act on one when it stands in for a field of its
    // own (a parent's unknown date of birth has no other control).
    const standIn = field.kind === 'checkbox' && checkboxStandIns.get(refCore(field.ref))
    if (field.kind === 'checkbox' && !standIn) continue

    // A stand-in checkbox carries no useful DOM label ("Do Not Know"), so look it
    // up under the field it represents.
    const found = standIn
      ? lookupValue({ ...field, ref: standIn.ref, label: standIn.label }, sources, registry)
      : lookupValue(field, sources, registry)
    if (!found) {
      if (
        isCeacNameField({ label: field.label, ref: field.ref }) &&
        ceacNameNeedsRewrite(field.value)
      ) {
        const cleaned = sanitizeCeacName(field.value)
        resolvedRefs.add(field.ref)
        pushAction(
          {
            type: 'fill',
            label: field.label || 'Employer Name',
            value: cleaned,
            ref: field.ref,
          },
          field,
        )
        continue
      }
      if (field.required) unresolvedRequired.push(field)
      continue
    }

    let { value, sourceLabel } = found

    if (isMissing(value)) continue

    if (isMarker(value) && field.kind !== 'radio') {
      const target = standIn ? field.ref : (dnaBelongsToField(field) ? field.dnaCbxRef : null)
      if (!target) {
        const fallback =
          field.required && (field.kind === 'select' || field.kind === 'select-large')
            ? lookupCountryFallback(field, sources)
            : null
        if (!fallback) {
          // Contact-person names are required unless the shared Do Not Know box
          // is ticked. Do not mark them resolved just because the source says
          // DO NOT KNOW — that left CEAC complaining the names were blank.
          if (/US_POC_(SURNAME|GIVEN_NAME)/i.test(field.ref || '')) {
            if (field.required) unresolvedRequired.push(field)
            continue
          }
          resolvedRefs.add(field.ref)
          continue
        }
        value = fallback
      } else {
        resolvedRefs.add(field.ref)
        // One checkbox can gate several inputs (the three U.S. SSN boxes) — but only
        // the ones it really belongs to, since page-inventory sometimes links a
        // neighbour's checkbox.
        for (const sibling of inventory.fields) {
          if (sibling.dnaCbxRef === target && dnaBelongsToField(sibling)) {
            resolvedRefs.add(sibling.ref)
          }
          if (/US_POC_NAME_NA/i.test(target) && /US_POC_(SURNAME|GIVEN_NAME)/i.test(sibling.ref || '')) {
            resolvedRefs.add(sibling.ref)
          }
        }
        if (checkedDna.has(target)) continue
        checkedDna.add(target)
        pushAction(
          {
            type: 'check',
            label: dnaLabelFor(target, inventory),
            // A stand-in checkbox's own DOM label is just "Do Not Know", so name
            // the field it represents instead.
            fieldLabel: standIn ? standIn.label : (field.label || sourceLabel),
            ref: target,
          },
          field,
        )
        continue
      }
    }

    // A stand-in checkbox only ever means "unknown". A real answer belongs to the
    // field it stands in for, which is in the inventory in its own right.
    if (standIn) continue

    const raw = coerceFieldValue(field, value)
    if (raw === null || raw === undefined || raw === '') {
      if (field.required) unresolvedRequired.push(field)
      continue
    }

    const occurrence = field.row || null
    let action = null

    if (field.kind === 'radio') {
      const answer = radioAnswer(field, raw)
      if (answer) {
        action = { type: 'radio', label: field.label || sourceLabel, value: answer, ref: field.ref }
      }
    } else if (field.kind === 'date') {
      const date = normalizeDate(raw)
      if (date) {
        // executeAction routes date parts by label when no dateParts are
        // present, so prefer the registry's unambiguous name over either the
        // scraped label or the source's wording.
        action = {
          type: 'fill',
          label: found.entry?.label || field.label || sourceLabel,
          value: date,
          ref: field.ref,
          dateParts: field.dateParts || undefined,
        }
      }
    } else if (field.kind === 'select' || field.kind === 'select-large') {
      const option = resolveOption(field, raw)
      if (option) {
        action = { type: 'selectOption', label: field.label || sourceLabel, value: option, ref: field.ref }
      }
    } else {
      action = {
        type: 'fill',
        label: found.entry?.label || field.label || sourceLabel,
        value: String(raw),
        ref: field.ref,
      }
    }

    if (!action) {
      if (field.required) unresolvedRequired.push(field)
      continue
    }

    if (occurrence) action.occurrence = occurrence
    resolvedRefs.add(field.ref)
    pushAction(action, field)
  }

  appendWorkAdditionalRepeaterActions({
    pageContext,
    inventory,
    answers,
    answerSheet,
    actions,
    resolvedRefs,
  })

  appendSocialMediaNoneAction({
    pageContext,
    inventory,
    answers,
    actions,
    resolvedRefs,
    unresolvedRequired,
  })

  applyUsContactOrgWithoutPerson({
    pageContext,
    inventory,
    sources,
    registry,
    resolvedRefs,
    unresolvedRequired,
    checkedDna,
    pushAction,
  })

  const nextButton =
    inventory.buttons.find((button) => /^next\b/i.test(button.text)) ||
    inventory.buttons.find((button) => /^continue\b/i.test(button.text))
  const repeatersIncomplete = workAdditionalRepeatersIncomplete(inventory, answers, answerSheet)
  const stayLengthOpen = intendedStayBlocksNext({
    pageContext,
    inventory,
    answers,
    answerSheet,
    actions,
    resolvedRefs,
  })

  return {
    actions,
    nextClick: nextButton && !repeatersIncomplete && !stayLengthOpen
      ? { type: 'click', text: nextButton.text }
      : null,
    resolvedRefs: [...resolvedRefs],
    unresolvedRequired,
    pageContext,
  }
}

function sourceWantsNoSpecificPlans(answers, answerSheet, inventory, actions) {
  if (answerSheet && typeof answerSheet.specific_travel_plans === 'boolean') {
    return answerSheet.specific_travel_plans === false
  }
  const planned = actions.find(
    (action) => action.type === 'radio' && /rblSpecificTravel/i.test(action.ref || ''),
  )
  if (planned) return /^no$/i.test(String(planned.value || ''))
  const radio = inventory.fields?.find((field) => /rblSpecificTravel/i.test(field.ref || ''))
  if (radio && /^no$/i.test(String(radio.value || ''))) return true
  return /specific travel plans\?\s*no\b/i.test(String(answers || ''))
}

/** CEAC only shows intended stay after "specific travel plans" = No. Do not Next first. */
function intendedStayBlocksNext({ pageContext, inventory, answers, answerSheet, actions, resolvedRefs }) {
  if (pageContext !== 'travel') return false
  if (!sourceWantsNoSpecificPlans(answers, answerSheet, inventory, actions)) return false
  const qty = inventory.fields.find((field) => /tbxTRAVEL_LOS$/i.test(field.ref || ''))
  const unit = inventory.fields.find((field) => /ddlTRAVEL_LOS_CD$/i.test(field.ref || ''))
  if (!qty || !unit) return true
  const resolved = new Set(resolvedRefs)
  return !resolved.has(qty.ref) || !resolved.has(unit.ref)
}

function sourceListValues(answers, answerSheet, { proseKey, sheetKey }) {
  const fromProse = parseSourceAnswers(answers)
    .filter((entry) => entry.normKey === normalizeKey(proseKey))
    .map((entry) => String(entry.value || '').trim())
    .filter((value) => value && !isMarker(value) && !isMissing(value))
  if (fromProse.length) return fromProse
  const fromSheet = answerSheet?.[sheetKey]
  if (!Array.isArray(fromSheet)) return []
  return fromSheet
    .map((value) => String(value || '').trim())
    .filter((value) => value && !isMarker(value) && !isMissing(value))
}

function workAdditionalListValues(answers, answerSheet) {
  return {
    languages: sourceListValues(answers, answerSheet, {
      proseKey: 'Languages spoken',
      sheetKey: 'languages',
    }),
    countries: sourceListValues(answers, answerSheet, {
      proseKey: 'Countries visited in the last 5 years',
      sheetKey: 'countries_visited_last_five_years',
    }),
  }
}

function workAdditionalRepeatersIncomplete(inventory, answers, answerSheet) {
  if (!inventory?.fields) return false
  const { languages, countries } = workAdditionalListValues(answers, answerSheet)
  const langRows = inventory.fields.filter((field) => refCore(field.ref) === 'tbxLANGUAGE_NAME').length
  const countryRows = inventory.fields.filter((field) => refCore(field.ref) === 'ddlCOUNTRIES_VISITED').length
  return languages.length > langRows || countries.length > countryRows
}

function contactNameIsUnknown(field, sources, registry) {
  if (!field) return true
  if (isFieldFilled(field) && !isMarker(field.value)) return false
  const found = lookupValue(field, sources, registry)
  if (!found || isMissing(found.value) || isMarker(found.value)) return true
  return !String(found.value || '').trim()
}

function dropUnresolved(unresolvedRequired, test) {
  for (let i = unresolvedRequired.length - 1; i >= 0; i--) {
    if (test(unresolvedRequired[i])) unresolvedRequired.splice(i, 1)
  }
}

/**
 * CEAC requires a contact person or an organization. A filled organization
 * with blank / DO NOT KNOW names must tick the shared person-name checkbox —
 * never leave the surname and given-name boxes empty.
 */
function applyUsContactOrgWithoutPerson({
  pageContext,
  inventory,
  sources,
  registry,
  resolvedRefs,
  unresolvedRequired,
  checkedDna,
  pushAction,
}) {
  if (pageContext !== 'contact') return
  const orgField = inventory.fields.find((field) => /tbxUS_POC_ORGANIZATION/i.test(field.ref || ''))
  const surname = inventory.fields.find((field) => /tbxUS_POC_SURNAME/i.test(field.ref || ''))
  const given = inventory.fields.find((field) => /tbxUS_POC_GIVEN_NAME/i.test(field.ref || ''))
  if (!orgField || (!surname && !given)) return

  const orgFound = lookupValue(orgField, sources, registry)
  const orgValue = (isFieldFilled(orgField) && orgField.value) || orgFound?.value || ''
  const orgReal = String(orgValue).trim() && !isMarker(orgValue) && !isMissing(orgValue)
  if (!orgReal) return
  if (!contactNameIsUnknown(surname, sources, registry) || !contactNameIsUnknown(given, sources, registry)) {
    return
  }

  for (const field of [surname, given]) {
    if (field) resolvedRefs.add(field.ref)
  }
  dropUnresolved(unresolvedRequired, (field) => /tbxUS_POC_(SURNAME|GIVEN_NAME)/i.test(field.ref || ''))

  if (checkedDna.has('cbxUS_POC_NAME_NA')) return
  checkedDna.add('cbxUS_POC_NAME_NA')
  pushAction(
    {
      type: 'check',
      label: 'Do Not Know',
      fieldLabel: 'Contact Person Surname',
      ref: 'cbxUS_POC_NAME_NA',
    },
    { triggersPostback: true },
  )
}

function appendSocialMediaNoneAction({
  pageContext,
  inventory,
  answers,
  actions,
  resolvedRefs,
  unresolvedRequired,
}) {
  if (pageContext !== 'address') return
  const socialFields = inventory.fields.filter((field) => /ddlSocialMedia/i.test(field.ref || ''))
  if (!socialFields.length) return
  if (parseSocialMediaFromSource(answers).length) return
  if (sourceUsedSocialMedia(answers) === true) return

  const field = socialFields[0]
  if (isFieldFilled(field)) {
    resolvedRefs.add(field.ref)
    dropUnresolved(unresolvedRequired, (item) => /ddlSocialMedia/i.test(item.ref || ''))
    return
  }

  const option = resolveOption(field, 'NONE') || 'NONE'
  const action = {
    type: 'selectOption',
    label: field.label || 'Social Media Provider/Platform',
    value: option,
    ref: field.ref,
    occurrence: field.row || 1,
  }
  actions.push(action)
  if (field.triggersPostback) actions.push({ type: 'wait' })
  resolvedRefs.add(field.ref)
  dropUnresolved(unresolvedRequired, (item) => /ddlSocialMedia/i.test(item.ref || ''))
}

function appendWorkAdditionalRepeaterActions({
  pageContext,
  inventory,
  answers,
  answerSheet,
  actions,
  resolvedRefs,
}) {
  if (pageContext !== 'work_additional') return
  const { languages, countries } = workAdditionalListValues(answers, answerSheet)
  const langRows = inventory.fields.filter((field) => refCore(field.ref) === 'tbxLANGUAGE_NAME').length
  const countryRows = inventory.fields.filter((field) => refCore(field.ref) === 'ddlCOUNTRIES_VISITED').length

  if (langRows > 0) {
    for (let i = langRows; i < languages.length; i++) {
      actions.push({ type: 'click', text: 'Add Another Language' })
      actions.push({
        type: 'fill',
        label: 'Language Name',
        value: languages[i],
        occurrence: i + 1,
      })
      resolvedRefs.add(`tbxLANGUAGE_NAME#${i + 1}`)
    }
  }

  if (countryRows > 0) {
    for (let i = countryRows; i < countries.length; i++) {
      actions.push({ type: 'click', text: 'Add Another Visited Country' })
      actions.push({
        type: 'selectOption',
        label: 'Country Visited',
        value: countries[i],
        occurrence: i + 1,
      })
      resolvedRefs.add(`ddlCOUNTRIES_VISITED#${i + 1}`)
    }
  }
}
