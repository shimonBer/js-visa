/**
 * Fill in the street address of any employer or school the source document did
 * not provide one for.
 *
 * The DS-160 requires a street address for every employer and school, and it
 * offers no "Does Not Apply" checkbox for that field — unlike State/Province and
 * Postal Code, which do have one. So a source that says "Address: N/A" leaves a
 * required field that cannot legally be left blank and cannot be filled from the
 * data, which stalls the autofill agent on a page the form keeps rejecting.
 *
 * Institutions are public places, so the address is looked up on the web rather
 * than invented. A result is only accepted when the model reports high
 * confidence and returns a street that actually looks like one; otherwise the
 * field is left for a human, because a wrong address on a visa application is
 * worse than a missing one.
 */

import { isMarkerValue } from '../autofill/ds160-fields.js'
import { OPENAI_MODELS } from './openaiModels.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

/**
 * "No address given" is the same question the autofill side asks before writing
 * to a field, so the vocabulary is shared rather than restated here — otherwise
 * a phrasing one side learns about stays invisible to the other.
 */
const isBlank = isMarkerValue

const NAME_KEY_RE = /^(?:employer|school|institution|organization|company)?_?name$/i
const STREET_KEY_RE = /(?:street|addr(?:ess)?)(?:_?(?:line)?_?1)?$/i
const SECOND_LINE_RE = /(?:line)?_?2$/i
const CITY_KEY_RE = /city$/i
const STATE_KEY_RE = /state|province/i
const COUNTRY_KEY_RE = /country|region/i
const POSTAL_KEY_RE = /postal|zip/i

function findKey(record, pattern, exclude = null) {
  return Object.keys(record).find(
    (key) => pattern.test(key) && (!exclude || !exclude.test(key)),
  )
}

/**
 * Walk an answer sheet and return every employer/school that has a name and a
 * city but no usable street address.
 *
 * Deliberately shape-agnostic: it recognizes an institution by its keys rather
 * than by a fixed path, so it works on the sections the field registry does not
 * describe yet and on sheets produced before those keys were pinned down.
 *
 * @param {object} answerSheet
 * @returns {Array<{record: object, streetKey: string, name: string, city: string,
 *   state: string, country: string, postalKey: string|null, where: string}>}
 */
export function findInstitutionsMissingAddress(answerSheet) {
  const found = []

  const visit = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (!node || typeof node !== 'object') return

    const nameKey = findKey(node, NAME_KEY_RE)
    const cityKey = findKey(node, CITY_KEY_RE)
    const streetKey = findKey(node, STREET_KEY_RE, SECOND_LINE_RE)

    if (nameKey && cityKey && streetKey && !isBlank(node[nameKey]) && isBlank(node[streetKey])) {
      const stateKey = findKey(node, STATE_KEY_RE)
      const countryKey = findKey(node, COUNTRY_KEY_RE)
      found.push({
        record: node,
        streetKey,
        postalKey: findKey(node, POSTAL_KEY_RE) || null,
        name: String(node[nameKey]).trim(),
        city: isBlank(node[cityKey]) ? '' : String(node[cityKey]).trim(),
        state: stateKey && !isBlank(node[stateKey]) ? String(node[stateKey]).trim() : '',
        country: countryKey && !isBlank(node[countryKey]) ? String(node[countryKey]).trim() : '',
        where: path,
      })
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') visit(value, path ? `${path}.${key}` : key)
    }
  }

  visit(answerSheet, '')
  return found
}

/**
 * Strip what the DS-160's address validator rejects. It accepts letters, digits,
 * spaces, hyphens, apostrophes, ampersands, slashes, commas and periods, but a
 * trailing period is what turned "Elbit Systems Ltd." into a validation error,
 * so punctuation at the end goes too.
 */
export function sanitizeStreet(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9 \-'&/,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '')
    .trim()
    .slice(0, 40)
}

/** A street has to contain a letter; a bare number or "-" is not an address. */
function looksLikeStreet(value) {
  const text = sanitizeStreet(value)
  return text.length >= 3 && /[A-Za-z]{2}/.test(text)
}

const SYSTEM_PROMPT = `You find the postal address of a named institution (a school, university, or company office).
Search the web and reply with JSON only:
{"street":"<street name and number>","postal_code":"<code or empty>","source":"<url you took it from>","confidence":"high"|"low"}

Rules:
- "street" is the street line only: name and building number. No city, region or country.
- Use the address of the specific branch or campus in the city given, not a head office elsewhere.
- Write it in English (Latin letters).
- Confirm the building number against at least two independent sources, and prefer
  official ones: the institution's own site, or the municipality or ministry register.
  Business directories and map listings copy each other's mistakes.
- If sources disagree on the building number, follow the official one.
- If you cannot verify the address of that institution in that city, return an empty
  street with confidence "low". Never guess: a wrong address on a visa application is
  worse than a missing one.`

/**
 * Look up one institution's street address.
 *
 * @returns {Promise<{street: string, postalCode: string, confidence: string}|null>}
 *   null when nothing trustworthy was found.
 */
export async function lookupInstitutionAddress(
  institution,
  apiKey,
  { fetchImpl = fetch, model = OPENAI_MODELS.addressLookup, timeoutMs = 30_000 } = {},
) {
  const query = [institution.name, institution.city, institution.state, institution.country]
    .filter(Boolean)
    .join(', ')
  if (!institution.name || !query) return null

  const response = await fetchImpl(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`address lookup HTTP ${response.status}`)

  const payload = await response.json()
  const content = payload?.choices?.[0]?.message?.content?.trim()
  if (!content) return null

  // Search models sometimes wrap the JSON in prose or a fenced block.
  const json = content.match(/\{[\s\S]*\}/)
  if (!json) return null

  let parsed
  try {
    parsed = JSON.parse(json[0])
  } catch {
    return null
  }

  if (String(parsed.confidence || '').toLowerCase() !== 'high') return null
  if (!looksLikeStreet(parsed.street)) return null

  return {
    street: sanitizeStreet(parsed.street),
    postalCode: String(parsed.postal_code ?? '').replace(/[^A-Za-z0-9 -]/g, '').trim(),
    source: String(parsed.source ?? '').trim(),
    confidence: 'high',
  }
}

/**
 * Fill in every missing employer/school street address in an answer sheet.
 *
 * Mutates the sheet in place and returns what happened, so the caller can log
 * which addresses came from the web rather than from the applicant.
 *
 * @returns {Promise<{resolved: Array<object>, unresolved: Array<object>}>}
 */
export async function resolveMissingInstitutionAddresses(
  answerSheet,
  apiKey,
  { fetchImpl = fetch, model, log = () => {}, timeoutMs } = {},
) {
  const missing = findInstitutionsMissingAddress(answerSheet)
  const resolved = []
  const unresolved = []

  for (const institution of missing) {
    let found = null
    // A refusal is often just search variance rather than a genuinely unlistable
    // address, so one retry is worth it. The acceptance rules below still apply
    // to the second answer, so retrying cannot talk the model into a guess.
    for (let attempt = 0; attempt < 2 && !found; attempt++) {
      try {
        found = await lookupInstitutionAddress(institution, apiKey, {
          fetchImpl, model, timeoutMs,
        })
      } catch (err) {
        log(`[address-lookup] "${institution.name}" failed: ${err.message}`)
        break
      }
    }

    if (!found) {
      unresolved.push({ name: institution.name, city: institution.city, where: institution.where })
      log(`[address-lookup] No verifiable address for "${institution.name}" — left for review`)
      continue
    }

    institution.record[institution.streetKey] = found.street
    // Only supply the postal code if the sheet left it blank: an applicant's own
    // value, or a deliberate "does not apply", must win over a search result.
    if (institution.postalKey && found.postalCode &&
        institution.record[institution.postalKey] === undefined) {
      institution.record[institution.postalKey] = found.postalCode
    }

    resolved.push({
      name: institution.name,
      city: institution.city,
      street: found.street,
      source: found.source,
      where: institution.where,
    })
    // The source is logged so a wrong building number can be traced back and
    // checked, rather than silently becoming part of the application.
    log(`[address-lookup] "${institution.name}" → "${found.street}"` +
        (found.source ? ` (${found.source})` : ''))
  }

  return { resolved, unresolved }
}
