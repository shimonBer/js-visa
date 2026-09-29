function byRef(ref) {
  if (!ref) return null
  return (
    document.getElementById(FORM_PREFIX + ref) ||
    document.getElementById(ref) ||
    document.querySelector(`input[id$="${ref}"], select[id$="${ref}"], textarea[id$="${ref}"]`)
  )
}

function byLabel(label, tags) {
  const want = normalizeLabel(label)
  if (!want) return null
  const nodes = [...document.querySelectorAll(tags)]
  for (const el of nodes) {
    if (!el.id) continue
    const labelled = normalizeLabel(
      document.querySelector(`label[for="${el.id}"]`)?.textContent || '',
    )
    if (labelled && (labelled === want || labelled.includes(want) || want.includes(labelled))) {
      return el
    }
  }
  return null
}

var STAY_UNITS = [
  [/year/i, 'Year(s)'],
  [/month/i, 'Month(s)'],
  [/week/i, 'Week(s)'],
  [/hour/i, 'Less Than 24 Hours'],
  [/day/i, 'Day(s)'],
]

function isStayHint(action) {
  return /travel_los|length of stay|intended stay/i.test(`${action.ref || ''} ${action.label || ''} ${action.fieldLabel || ''}`)
}

/** Keep in sync with lib/phoneFormatting.js — content scripts cannot import that module. */
function normalizePhoneFillValue(value, action) {
  if (typeof value !== 'string') return value
  const hay = `${action.label || ''} ${action.fieldLabel || ''} ${action.ref || ''}`
  if (/used any other phone|other phone numbers.*last five years/i.test(hay)) return value
  if (!/phone|telephone|_TEL\b|AddPhone|EmpPhone|PayerPhone/i.test(hay)) return value
  const trimmed = value.trim()
  if (!trimmed || /^(?:n\/?a|none|null|nil|unknown|missing|❗\s*missing|does not apply|not applicable)$/i.test(trimmed)) {
    return value
  }
  return trimmed.replace(/\D/g, '') || value
}

function applyStayLength(action) {
  const input = document.querySelector('input[id$="tbxTRAVEL_LOS"]')
  const select = document.querySelector('select[id$="ddlTRAVEL_LOS_CD"]')
  if (!input && !select) return false
  const value = String(action.value || '')
  const qty = value.match(/\d+/)?.[0]
  const unit =
    STAY_UNITS.find(([re]) => re.test(value))?.[1] ||
    (action.type === 'selectOption' && !/^\d+$/.test(value.trim()) ? value : null)
  if (qty && input) {
    input.focus()
    input.value = qty
    fire(input, 'input')
    fire(input, 'change')
  }
  if (unit && select) selectClosest(select, unit)
  return Boolean((qty && input) || (unit && select))
}

function findControl(action, tags) {
  const el = byRef(action.ref)
  if (el) return el
  return byLabel(action.label || action.fieldLabel, tags)
}

function fire(el, type) {
  el.dispatchEvent(new Event(type, { bubbles: true }))
}

var JVISA_PREPARER = {
  organization: 'JVISA',
  street: '27 HERMON STREET',
  city: 'NAHARIYA',
  postal: '2220527',
  country: 'ISRAEL',
  relationship: 'CLERK',
}

function clickIfUnchecked(el) {
  if (!el || el.checked) return false
  el.click()
  return true
}

function byNearbyLabel(label, tags) {
  const want = normalizeLabel(label)
  if (!want) return null
  const nodes = [...document.querySelectorAll('span, label, td, th, legend, p, div')]
  for (const node of nodes) {
    const own = [...node.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join(' ')
    const text = normalizeLabel(own)
    if (text !== want && !text.includes(want)) continue
    const root = node.closest('tr, .field, .field-group, td, div') || node.parentElement
    const el = root?.querySelector(tags)
    if (el) return el
  }
  return null
}

function setControlValue(el, value) {
  if (!el) return false
  const next = String(value ?? '')
  if (el.tagName === 'SELECT') {
    const current = el.options[el.selectedIndex]?.text?.trim() || ''
    if (current.toUpperCase().includes(next.toUpperCase())) return false
    try {
      selectClosest(el, next)
      return true
    } catch {
      try {
        selectClosest(el, 'OTHER')
        return true
      } catch {
        return false
      }
    }
  }
  if (String(el.value || '').trim().toUpperCase() === next.toUpperCase()) return false
  el.focus()
  el.value = next
  fire(el, 'input')
  fire(el, 'change')
  return true
}

function findPreparerCountry() {
  const selectors = [
    '#ctl00_SiteContentPlaceHolder_FormView3_ddlCountry',
    'select[id*="FormView3"][id$="ddlCountry"]',
    'select[id*="FormView3"][id*="CNTRY" i]',
    'select[id*="PREP"][id*="CNTRY" i]',
    'select[id*="PREP"][id*="COUNTRY" i]',
    'select[id$="ddlPREP_CNTRY"]',
    'input[id*="PREP"][id*="CNTRY"]',
    'input[id$="tbxPREP_CNTRY"]',
  ]
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (el) return el
  }
  return (
    findControl({ label: 'Country/Region' }, 'select') ||
    byNearbyLabel('Country/Region', 'select')
  )
}

function preparerCountryValue() {
  const el = findPreparerCountry()
  if (!el) return ''
  if (el.tagName === 'SELECT') return String(el.options[el.selectedIndex]?.text || '').trim()
  return String(el.value || '').trim()
}

function findPreparerRelationship() {
  return (
    document.querySelector(
      'select[id*="PREP"][id*="REL"], select[id$="ddlPREP_REL"], ' +
        'input[id*="PREP"][id*="REL"]:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), ' +
        'input[id$="tbxPREP_REL"]',
    ) ||
    findControl(
      { label: 'Relationship to You' },
      'select, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])',
    ) ||
    byNearbyLabel(
      'Relationship to You',
      'select, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])',
    )
  )
}

function preparerRelationshipValue() {
  const el = findPreparerRelationship()
  if (!el) return ''
  if (el.tagName === 'SELECT') return String(el.options[el.selectedIndex]?.text || '').trim()
  return String(el.value || '').trim()
}

function syncJvisaPreparer() {
  const yes = document.querySelector(
    '#ctl00_SiteContentPlaceHolder_FormView3_rblPREP_IND_0, input[id$="rblPREP_IND_0"]',
  )
  if (yes && !yes.checked) {
    yes.click()
    return { ok: true, posted: true }
  }

  clickIfUnchecked(
    document.querySelector(
      'input[type="checkbox"][id*="PREP"][id*="NAME"][id*="NA"], input[type="checkbox"][id*="PREP_NAME"]',
    ),
  )
  clickIfUnchecked(document.querySelector('input[type="checkbox"][id*="PREP"][id*="STATE"][id*="NA"]'))

  const fills = [
    ['input[id*="PREP"][id*="ORGANIZATION"], input[id$="tbxPREP_ORGANIZATION"]', JVISA_PREPARER.organization],
    ['input[id*="PREP"][id*="ADDR"], input[id$="tbxPREP_ADDR_LN1"]', JVISA_PREPARER.street],
    ['input[id*="PREP"][id*="CITY"], input[id$="tbxPREP_CITY"]', JVISA_PREPARER.city],
    ['input[id*="PREP"][id*="POSTAL"], input[id$="tbxPREP_POSTAL_CD"]', JVISA_PREPARER.postal],
  ]
  for (const [sel, value] of fills) {
    setControlValue(document.querySelector(sel), value)
  }
  setControlValue(findPreparerCountry(), JVISA_PREPARER.country)

  const rel = findPreparerRelationship()
  if (!rel) throw new Error('No Relationship to You field')
  setControlValue(rel, JVISA_PREPARER.relationship)
  return { ok: true, posted: false }
}

function refreshCaptcha() {
  const link = document.querySelector(
    'a.LBD_ReloadLink, a[title*="Change the CAPTCHA" i], img.LBD_ReloadIcon',
  )
  if (!link) throw new Error('No CAPTCHA refresh control')
  ;(link.closest('a') || link).click()
  return { ok: true }
}

function headingText() {
  const section = document.querySelector(
    '#ctl00_SiteContentPlaceHolder_Label1, h2 span[id$="Label1"]',
  )
  const sectionText = section?.textContent?.replace(/\s+/g, ' ').trim()
  if (sectionText) return sectionText
  for (const sel of ['h2', 'h3', 'legend', '.step-title']) {
    const el = document.querySelector(sel)
    const text = el?.textContent?.replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return document.title || ''
}

function parseDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  return { day: String(parseInt(m[1], 10)), month: m[2].padStart(2, '0'), year: m[3] }
}

var MONTH_ABBREVS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function normalizeSecurityQuestion(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

var COUNTRY_DEMONYMS = {
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

function countryWanted(wanted) {
  const mapped = COUNTRY_DEMONYMS[String(wanted || '').trim().toLowerCase()]
  return mapped || wanted
}

function selectClosest(el, wanted) {
  const raw = countryWanted(wanted)
  const want = String(raw).trim().toUpperCase()
  const wantNorm = normalizeSecurityQuestion(raw)
  const opts = [...el.options]
  const label = (o) => o.text.trim().toUpperCase()
  const match =
    opts.find((o) => label(o) === want) ||
    opts.find((o) => o.value.toUpperCase() === want) ||
    opts.find((o) => label(o).includes(want)) ||
    opts.find((o) => want.length >= 4 && want.startsWith(label(o)) && label(o).length >= 4) ||
    opts.find((o) => normalizeSecurityQuestion(o.text) === wantNorm) ||
    opts.find((o) => {
      const text = normalizeSecurityQuestion(o.text)
      return text.length > 12 && text.includes(wantNorm)
    })
  if (!match) throw new Error(`No select option for "${wanted}"`)
  el.value = match.value
  fire(el, 'change')
}

function fillDate(action) {
  const parts = parseDate(action.value)
  if (!parts) throw new Error(`Bad date "${action.value}"`)
  const monthAbbrev = MONTH_ABBREVS[parseInt(parts.month, 10) - 1]
  const ids = action.dateParts || {}
  const dayEl = byRef(ids.day)
  const monthEl = byRef(ids.month)
  const yearEl = byRef(ids.year)
  if (!monthEl || !yearEl) throw new Error(`Date controls missing for ${action.ref}`)
  if (dayEl) {
    try {
      selectClosest(dayEl, parts.day)
    } catch {
      selectClosest(dayEl, String(parts.day).padStart(2, '0'))
    }
  }
  selectClosest(monthEl, monthAbbrev)
  yearEl.focus()
  yearEl.value = parts.year
  fire(yearEl, 'input')
  fire(yearEl, 'change')
}

function clickRadio(action) {
  if (/did anyone assist/i.test(action.label || '')) {
    const wantNo = /^no$/i.test(String(action.value || '').trim())
    const radio = document.querySelector(
      wantNo
        ? '#ctl00_SiteContentPlaceHolder_FormView3_rblPREP_IND_1, input[id$="rblPREP_IND_1"]'
        : '#ctl00_SiteContentPlaceHolder_FormView3_rblPREP_IND_0, input[id$="rblPREP_IND_0"]',
    )
    if (radio) {
      if (radio.checked) return
      radio.click()
      return
    }
  }
  const table =
    byRef(action.ref) ||
    document.querySelector(`table[id$="${action.ref}"], [id$="${action.ref}"]`)
  const scope = table || document
  const want = String(action.value || '').toLowerCase()
  const radios = [...scope.querySelectorAll('input[type="radio"]')]
  for (const radio of radios) {
    const lbl = document.querySelector(`label[for="${radio.id}"]`)
    const txt = (lbl?.textContent || radio.parentElement?.textContent || '').trim().toLowerCase()
    if (txt === want || txt.split(/\s+/).includes(want) ||
        (want === 'yes' && (radio.value === 'Y' || radio.value === 'y')) ||
        (want === 'no' && (radio.value === 'N' || radio.value === 'n'))) {
      radio.click()
      fire(radio, 'change')
      return
    }
  }
  throw new Error(`Radio "${action.value}" not found for ${action.ref}`)
}

function normalizeLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function isBlockedSubmissionClick(action) {
  if (action?.type !== 'click' || !action.text) return false
  const text = String(action.text).trim()
  if (/^next\s*:\s*sign and submit$/i.test(text)) return false
  const lower = text.toLowerCase()
  return (
    lower.includes('sign and submit') ||
    lower.includes('submit application') ||
    lower.includes('submit this application') ||
    lower.includes('final submit') ||
    lower.includes('submit now')
  )
}

function clickLabel(el) {
  const nestedAlt = el.querySelector?.('img')?.getAttribute('alt') || ''
  return normalizeLabel(
    el.value || el.getAttribute('alt') || el.getAttribute('title') || nestedAlt || el.textContent || '',
  )
}

function canonClick(value) {
  return normalizeLabel(value).replace(/&/g, 'and')
}

function isCeacChromeNavigation(el) {
  if (!el) return false
  const id = el.id || ''
  if (
    [
      'GetStarted', 'Personal', 'Travel', 'TravelCompanions', 'PreviousUSTravel',
      'AddressPhone', 'PptVisa', 'USContact', 'Family', 'WorkEducationMain', 'SecAndBackMain',
      'COMPLETE', 'PHOTO', 'REVIEW', 'ESIGN',
      'ctl00_lbtnExit', 'ctl00_lbtnHelp', 'ctl00_lbtnContactUs', 'ctl00_banner',
    ].includes(id)
  ) return true
  return Boolean(el.closest('#sideNav, #nav-sidebar, #nav-global, #branding, #nav-main'))
}

function clickByText(text) {
  const want = normalizeLabel(text)
  if (!want) throw new Error('No click text')
  const wantCanon = canonClick(want)
  if (/start an application/i.test(text || '')) {
    const start = document.querySelector(
      [
        '#ctl00_SiteContentPlaceHolder_lnkNew',
        'a[id$="lnkNew"]',
        'a[id*="lnkNew"]',
        '#ctl00_SiteContentPlaceHolder_ucLocationSearch_btnNewApp',
        'input[id*="btnNewApp"]',
        'a[id*="btnNewApp"]',
        'button[id*="btnNewApp"]',
        'input[type="image"][id*="NewApp" i]',
        'input[type="submit"][value*="START AN APPLICATION" i]',
        'input[type="button"][value*="START AN APPLICATION" i]',
        'input[type="image"][alt*="START AN APPLICATION" i]',
        'input[title*="START AN APPLICATION" i]',
      ].join(', '),
    ) || [...document.querySelectorAll('a[role="Button"], a[role="button"]')].find((node) =>
      /start an application/i.test(node.textContent || ''),
    )
    if (!start) throw new Error('No click target "START AN APPLICATION"')
    start.removeAttribute('disabled')
    start.disabled = false
    document.documentElement.dispatchEvent(new Event('ds160-start-application', { bubbles: true }))
    start.click()
    return
  }
  if (/^upload (?:your )?photo$/i.test(text || '')) {
    const upload = document.querySelector(
      'input[id$="btnUploadPhoto"], input.uploadphoto, input[class*="uploadphoto"]',
    )
    if (!upload) throw new Error('No click target "Upload Your Photo"')
    upload.click()
    return
  }
  if (/print application/i.test(text || '')) {
    const printApp = document.querySelector(
      '#ctl00_SiteContentPlaceHolder_FormView1_btnPrintApp, input.printapp, input[id$="btnPrintApp"]',
    )
    if (!printApp) throw new Error('No click target "Print Application"')
    printApp.click()
    return
  }
  if (/continue without (?:a )?photo/i.test(text || '')) {
    const skip = document.querySelector(
      'input[id$="btnNoImage"], input[type="image"][id*="NoImage" i], input[alt*="Continue Without" i]',
    )
    if (!skip) throw new Error('No click target "Continue Without a Photo"')
    skip.click()
    return
  }
  if (/^(next|continue)\b/.test(want)) {
    const sign = document.querySelector('#ctl00_SiteContentPlaceHolder_btnSignApp, input[id$="btnSignApp"]')
    if (sign) throw new Error('Not clicking Next before Sign and Submit')
    const official = document.querySelector(
      'input.next[id$="UpdateButton3"], input[id$="UpdateButton3"], input[type="submit"].next, input[id$="btnContinue"]',
    )
    if (official && !official.disabled) {
      official.click()
      return
    }
  }
  const els = [
    ...document.querySelectorAll(
      'input[type="submit"], input[type="button"], input[type="image"], button, a',
    ),
  ]
  let match = null
  for (const el of els) {
    if (isCeacChromeNavigation(el)) continue
    const label = clickLabel(el)
    if (!label) continue
    const labelCanon = canonClick(label)
    const exact = label === want || labelCanon === wantCanon
    const prefix = label.startsWith(want) || labelCanon.startsWith(wantCanon)
    // Wrapping links include the button caption in textContent; skip those.
    const contained = label.length <= want.length + 24 && (
      label.includes(want) ||
      labelCanon.includes(wantCanon) ||
      (want.length > 4 && want.includes(label))
    )
    if (exact || prefix || contained) {
      match = el
      if (exact) break
    }
  }
  if (!match && /^(next|continue)\b/.test(want)) {
    const navs = els.filter((el) => {
      const tag = (el.tagName || '').toLowerCase()
      const label = clickLabel(el)
      if (tag === 'a') return false
      return /^(next|continue)\b/.test(label) && !/^back\b/.test(label)
    })
    match =
      navs.find((el) => canonClick(clickLabel(el)).includes(wantCanon.replace(/^next:\s*/, 'next: '))) ||
      navs.find((el) => /^next\s*:/.test(clickLabel(el))) ||
      navs.find((el) => /^next\b/.test(clickLabel(el))) ||
      navs.find((el) => /^continue\b/.test(clickLabel(el))) ||
      document.querySelector(
        'input[id$="UpdateButton3"], input[id$="btnNext"], input[id$="btnContinue"], input[id*="btnNext"]',
      )
  }
  if (!match) throw new Error(`No click target "${text}"`)
  match.click()
}

async function executeAction(action) {
  if (!action?.type || action.type === 'wait') {
    await new Promise((r) => setTimeout(r, 1500))
    return { ok: true, type: 'wait' }
  }
  if (['done', 'defer', 'solveCaptcha'].includes(action.type)) {
    return { ok: true, skipped: action.type }
  }
  if (action.type === 'syncJvisaPreparer') {
    return syncJvisaPreparer()
  }
  if (action.type === 'refreshCaptcha') {
    return refreshCaptcha()
  }
  if (action.type === 'submitApplication') {
    const yesAssistance = document.querySelector(
      '#ctl00_SiteContentPlaceHolder_FormView3_rblPREP_IND_0, input[id$="rblPREP_IND_0"]',
    )
    const organization = document.querySelector(
      'input[id*="PREP"][id*="ORGANIZATION"], input[id$="tbxPREP_ORGANIZATION"]',
    )
    const passport = document.querySelector('#ctl00_SiteContentPlaceHolder_PPTNumTbx, input[id$="PPTNumTbx"]')
    const captcha = document.querySelector('#ctl00_SiteContentPlaceHolder_CodeTextBox, input[type="text"][id$="CodeTextBox"]')
    const sign = document.querySelector('#ctl00_SiteContentPlaceHolder_btnSignApp, input[id$="btnSignApp"]')
    if (!yesAssistance?.checked) throw new Error('Assistance answer is not Yes')
    if (!/jvisa/i.test(String(organization?.value || ''))) throw new Error('JVisa organization is empty')
    const relationship = preparerRelationshipValue()
    if (!relationship || /^(select one|--)$/i.test(relationship)) {
      throw new Error('Preparer relationship is empty')
    }
    const country = preparerCountryValue()
    if (findPreparerCountry() && !/israel/i.test(country)) {
      throw new Error('Preparer country is not Israel')
    }
    if (!String(passport?.value || '').trim()) throw new Error('Passport number is empty')
    if (!String(captcha?.value || '').trim()) throw new Error('CAPTCHA is empty')
    if (!sign) throw new Error('No Sign and Submit Application button')
    sign.click()
    return { ok: true }
  }
  if (action.type === 'uploadPhoto') {
    const input = document.querySelector('input[type="file"]')
    if (!input) throw new Error('No file input')
    const raw = String(action.imageBase64 || '').replace(/^data:image\/jpeg;base64,/, '')
    if (!raw) throw new Error('No photo data from the bridge')
    const binary = atob(raw)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const file = new File([bytes], 'blank-test-photo.jpg', { type: 'image/jpeg' })
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    fire(input, 'input')
    fire(input, 'change')
    return { ok: true, files: input.files.length }
  }
  if (action.type === 'reviewNext') {
    clickByText(action.text || 'Next')
    return { ok: true }
  }
  if (action.type === 'fill' && action.dateParts) {
    fillDate(action)
    return { ok: true }
  }
  if (action.type === 'fill' || action.type === 'selectOption') {
    if (isStayHint(action) && applyStayLength(action)) {
      return { ok: true }
    }
  }
  if (action.type === 'fill') {
    const el = findControl(
      action,
      'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select',
    )
    if (!el) throw new Error(`No field ${action.ref || action.label || '(missing ref)'}`)
    if (el.tagName === 'SELECT') {
      selectClosest(el, action.value)
      return { ok: true }
    }
    el.focus()
    el.value = normalizePhoneFillValue(action.value ?? '', action)
    fire(el, 'input')
    fire(el, 'change')
    return { ok: true }
  }
  if (action.type === 'selectOption') {
    const el = findControl(
      action,
      'select, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])',
    )
    if (!el) throw new Error(`No select ${action.ref || action.label || '(missing ref)'}`)
    if (el.tagName !== 'SELECT') {
      el.focus()
      el.value = action.value ?? ''
      fire(el, 'input')
      fire(el, 'change')
      return { ok: true }
    }
    selectClosest(el, action.value)
    return { ok: true }
  }
  if (action.type === 'radio') {
    clickRadio(action)
    return { ok: true }
  }
  if (action.type === 'check') {
    let el = action.ref ? byRef(action.ref) : null
    const hint = `${action.fieldLabel || ''} ${action.label || ''}`
    if (!el && /preparer names|given name|surnames/i.test(hint)) {
      el = document.querySelector(
        'input[type="checkbox"][id*="PREP"][id*="NAME"][id*="NA"], input[type="checkbox"][id*="PREP_NAME"]',
      )
    } else if (!el && /state\/?province|state or province/i.test(hint)) {
      el = document.querySelector('input[type="checkbox"][id*="PREP"][id*="STATE"][id*="NA"]')
    }
    if (!el) throw new Error(`No checkbox ${action.ref || action.fieldLabel || action.label}`)
    if (!el.checked) el.click()
    return { ok: true }
  }
  if (action.type === 'click') {
    if (isBlockedSubmissionClick(action)) {
      return { ok: true, skipped: 'submit-blocked' }
    }
    clickByText(action.text || action.label)
    return { ok: true }
  }
  if (action.type === 'selectEmbassy') {
    const ddl = document.querySelector(
      '#ctl00_SiteContentPlaceHolder_ucLocationSearch_ddlLocation, select[id$="ddlLocation"]',
    )
    if (!ddl) throw new Error('No embassy dropdown')
    const current = ddl.options[ddl.selectedIndex]?.text || ''
    if (current.toUpperCase().includes(String(action.value || 'TEL AVIV').toUpperCase())) {
      return { ok: true, skipped: 'already-selected' }
    }
    selectClosest(ddl, action.value || 'Tel Aviv')
    return { ok: true }
  }
  if (action.type === 'checkAgree') {
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
    for (const el of boxes) {
      const id = `${el.id || ''} ${el.name || ''}`.toLowerCase()
      const nearby = (
        document.querySelector(`label[for="${el.id}"]`)?.textContent ||
        el.closest('label')?.textContent ||
        el.closest('tr, td, li, div, p, span')?.textContent ||
        el.parentElement?.textContent ||
        el.nextElementSibling?.textContent ||
        ''
      ).replace(/\s+/g, ' ').toLowerCase()
      if (
        /agree/.test(id) ||
        /\bi agree\b/.test(nearby) ||
        /i have read/.test(nearby) ||
        /privacy act/.test(nearby)
      ) {
        if (!el.checked) {
          el.click()
          fire(el, 'change')
        }
        return { ok: true }
      }
    }
    throw new Error('No I agree checkbox')
  }
  if (action.type === 'selectSecurityQuestion') {
    const ddl = document.querySelector(
      'select[id*="SecurityQuestion"], select[name*="SecurityQuestion"], select[id*="ddlQuestions"]',
    )
    if (!ddl) throw new Error('No security question dropdown')
    selectClosest(ddl, action.value)
    return { ok: true }
  }
  if (action.type === 'fillSecurityAnswer') {
    const el = document.querySelector(
      'input[id*="SecurityAnswer"], input[name*="SecurityAnswer"], input[id*="txtAnswer"]',
    )
    if (!el) throw new Error('No security answer field')
    el.focus()
    el.value = action.value ?? ''
    fire(el, 'input')
    fire(el, 'change')
    return { ok: true }
  }
  if (action.type === 'fillCaptcha') {
    const value = String(action.value || '').trim()
    if (!value) throw new Error('Empty CAPTCHA answer')
    const selectors = [
      '#ctl00_SiteContentPlaceHolder_CodeTextBox',
      '#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha',
      '#ctl00_SiteContentPlaceHolder_ucAppSecurityQuestion_txtcaptcha',
      'input[type="text"][id$="CodeTextBox"]',
      'input[type="text"][id*="txtcaptcha" i]',
      'input[type="text"][id*="captcha" i]',
      'input[type="text"][name*="captcha" i]',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (!el || el.disabled || el.type === 'hidden') continue
      el.focus()
      el.value = value
      fire(el, 'input')
      fire(el, 'change')
      return { ok: true }
    }
    throw new Error('No CAPTCHA input field')
  }
  return { ok: false, error: `unsupported ${action.type}` }
}

var CAPTCHA_IMG_SELECTORS = [
  'img.LBD_CaptchaImage',
  'img[id$="CaptchaImage"]',
  '#ctl00_SiteContentPlaceHolder_ucLocationSearch_CaptchaImage',
  '#ctl00_SiteContentPlaceHolder_ucAppSecurityQuestion_CaptchaImage',
  'img[alt="CAPTCHA"]',
  'img[src*="get=image" i][src*="captcha" i]',
  'img[src*="captcha" i]',
  'img[src*="Captcha" i]',
  'img[id*="captcha" i]',
  'img[id*="Captcha" i]',
  'img[alt*="captcha" i]',
]

function findCaptchaImage() {
  for (const sel of CAPTCHA_IMG_SELECTORS) {
    const el = document.querySelector(sel)
    if (!el || el.tagName !== 'IMG') continue
    if (/reload|sound|icon/i.test(`${el.id} ${el.className} ${el.alt || ''} ${el.src || ''}`)) continue
    return el
  }
  return null
}

function captureCaptchaPng() {
  const img = findCaptchaImage()
  if (!img || img.naturalWidth < 2) return null
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d').drawImage(img, 0, 0)
  return canvas.toDataURL('image/png')
}

async function ds160Handle(message) {
  if (message?.type === 'snapshot') {
      return {
        href: location.href,
        heading: headingText(),
        title: document.title || '',
        bodyText: (document.body?.innerText || '').slice(0, 800),
        signedSubmitted: /successfully signed and submitted your application/i.test(
          document.body?.innerText || '',
        ),
        hasSignButton: Boolean(
          document.querySelector('#ctl00_SiteContentPlaceHolder_btnSignApp, input[id$="btnSignApp"]'),
        ),
        hasPrintApplication: Boolean(
          document.querySelector('input.printapp, input[id$="btnPrintApp"]'),
        ),
        inventory: collectPageInventory(),
      }
  }
  if (message?.type === 'captchaSnapshot') {
    const img = findCaptchaImage()
    return {
      href: location.href,
      captchaPng: captureCaptchaPng(),
      captchaSrc: img?.src || '',
    }
  }
  if (message?.type === 'hasFileInput') {
    return {
      ok: Boolean(document.querySelector('input[type="file"]')),
      href: location.href,
    }
  }
  if (message?.type === 'execute') {
    const results = []
    for (const action of message.actions || []) {
      try {
        results.push({ action, ...(await executeAction(action)) })
      } catch (err) {
        results.push({ action, ok: false, error: err.message })
      }
    }
    return { results }
  }
  return { error: 'unknown message' }
}

window.__ds160AgentReady = true
