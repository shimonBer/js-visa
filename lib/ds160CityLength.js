/** Character limits taken from the official DS-160 maxlength attributes. */

export const CITY_MAX_LENGTH = 20

export const CITY_TOO_LONG_MESSAGE =
  'שם העיר מוגבל ל-20 תווים. קצרו אותו לפני התרגום.'

const EXACT_PORTAL_LIMITS = {
  passportIssuingCity: 25,
  passportIssuingState: 25,
  passportId: 20,
  passportBookNumber: 20,
  idNumber: 20,
  taxpayerIDNumber: 20,
  visaNumber: 12,
  clanOrTribeName: 80,
  firstName: 100,
  lastName: 100,
  firstNameEnglish: 33,
  lastNameEnglish: 33,
  contactOrganization: 33,
  tripPayerOrgName: 33,
  monthlySalaryGross: 15,
  studentMonthlyIncome: 15,
}

function leafAndOwner(path) {
  const parts = String(path ?? '').split('.').filter(Boolean)
  const leaf = parts[parts.length - 1] || ''
  let owner = parts[parts.length - 2] || ''
  if (/^\d+$/.test(owner)) owner = parts[parts.length - 3] || ''
  return { leaf, owner }
}

const MARKER_RE =
  /^(?:n\/?a|none|null|nil|unknown|missing|❗\s*missing|does not apply|not applicable|do not know)$/i

const LEADING_ADMIN_RES = [
  /^(?:regional|local)\s+council\s+of\s+/i,
  /^municipality\s+of\s+/i,
  /^מועצה\s+(?:אזורית|מקומית)\s+/,
]

const TRAILING_ADMIN_RES = [
  /\s+regional\s+council$/i,
  /\s+local\s+council$/i,
  /\s+regional\s+municipality$/i,
  /\s+city\s+council$/i,
  /\s+municipality$/i,
]

export function isCityFieldName(name) {
  const { leaf } = leafAndOwner(name)
  return /city$/i.test(leaf)
}

/**
 * Official maxlength for a portal field path, or null when the DS-160 box
 * is a dropdown, a date, or not length-limited.
 */
export function limitForPortalField(path) {
  const { leaf, owner } = leafAndOwner(path)
  if (!leaf || /(?:DoesNotApply|DoNotKnow|NA)$/i.test(leaf)) return null
  if (Object.prototype.hasOwnProperty.call(EXACT_PORTAL_LIMITS, leaf)) return EXACT_PORTAL_LIMITS[leaf]
  if (owner === 'telecodes') return 20
  if (owner === 'lostPassports' && leaf === 'number') return 20
  if (owner === 'usDriversLicenses' && leaf === 'number') return 20
  if (owner === 'foreignNationalities' && leaf === 'id') return 20
  if (owner === 'socialMediaAccounts' && leaf === 'identifier') return 50
  if (owner === 'socialMediaAccounts' && leaf === 'platform') return 40
  if (owner === 'languagesList' && leaf === 'name') return 66
  if (owner === 'organizations' && leaf === 'name') return 66
  if (owner === 'locationsToVisit' && leaf === 'location') return 40
  if (/explanation$/i.test(leaf) || leaf === 'explain' || leaf === 'duties' || leaf === 'jobDuties' || leaf === 'unemploymentReason') return 4000
  if (/city$/i.test(leaf)) return 20
  if (/state$/i.test(leaf)) return 20
  if (/zip$/i.test(leaf) || /postal$/i.test(leaf)) return 10
  if (/phone$/i.test(leaf) || leaf === 'phoneNumber') return 15
  if (owner === 'otherEmails' && leaf === 'address') return 40
  if (/email$/i.test(leaf)) return 50
  if (/street\d?$/i.test(leaf)) return 40
  if (/^(?:surnames|surname|givenNames|givenName|given)$/i.test(leaf)) return 33
  if (/^(?:employerName|institutionName|studentInstitutionName|groupName)$/i.test(leaf)) return 75
  if (leaf === 'courseOfStudy') return 66
  if (/^(?:branch|rank|specialty)$/i.test(leaf)) return 40
  if (/flight$/i.test(leaf)) return 20
  return null
}

export function fieldTooLongMessage(path, value) {
  const max = limitForPortalField(path)
  if (!max) return ''
  const text = String(value ?? '').trim()
  if (!text || MARKER_RE.test(text) || text.length <= max) return ''
  const subject = isCityFieldName(path) ? 'שם העיר' : 'השדה'
  return `${subject} מוגבל ל-${max} תווים. קצרו אותו לפני התרגום. (${text.length} תווים)`
}

export function isTranslatedCityLabel(label) {
  return /(?:^|\s)city(?:\s+of\s+birth)?$/i.test(String(label ?? '').trim())
}

export function cityTooLongMessage(value) {
  return fieldTooLongMessage('city', value)
}

function valueAtPath(source, path) {
  return String(path).split('.').reduce(
    (acc, key) => (acc == null ? undefined : acc[key]),
    source,
  )
}

export function collectOverlongFieldPaths(source) {
  const paths = []
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${prefix}${index}.`))
      return
    }
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}${key}`
      if (typeof value === 'string' && fieldTooLongMessage(path, value)) paths.push(path)
      else if (value && typeof value === 'object') walk(value, `${path}.`)
    }
  }
  walk(source && typeof source === 'object' ? source : {}, '')
  return paths
}

export function collectOverlongCityPaths(source) {
  return collectOverlongFieldPaths(source).filter((path) => isCityFieldName(path))
}

export function fieldAtPathTooLong(source, path) {
  return Boolean(fieldTooLongMessage(path, valueAtPath(source, path)))
}

export function cityAtPathTooLong(source, path) {
  return isCityFieldName(path) && fieldAtPathTooLong(source, path)
}

/**
 * Keep the place name inside the DS-160 city limit.
 * "Maale Gamla regional council" → "Maale Gamla".
 */
export function shortenDs160City(value, max = CITY_MAX_LENGTH) {
  const original = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!original || MARKER_RE.test(original) || original.length <= max) return original

  let text = original
  let previous
  do {
    previous = text
    for (const pattern of LEADING_ADMIN_RES) text = text.replace(pattern, '')
    for (const pattern of TRAILING_ADMIN_RES) text = text.replace(pattern, '')
    text = text.replace(/^[,\-–\s]+|[,\-–\s]+$/g, '').trim()
  } while (text && text !== previous)

  if (!text) text = original
  if (text.length <= max) return text

  const words = text.split(' ')
  while (words.length > 1 && words.join(' ').length > max) words.pop()
  text = words.join(' ')
  if (text.length <= max) return text
  return text.slice(0, max).trim()
}

const TRANSLATED_LABEL_LIMITS = [
  [/passport issuance city/i, 25],
  [/passport issuance state|issuance state/i, 25],
  [/city(?:\s+of\s+birth)?$/i, 20],
  [/(?:^|\s)state(?:\s*\/\s*province)?$/i, 20],
  [/zip|postal/i, 10],
  [/phone|telephone/i, 15],
  [/email/i, 50],
  [/street address|employer address|^address$/i, 40],
  [/full name in native alphabet/i, 100],
  [/surname|given name/i, 33],
  [/organization name/i, 33],
  [/school\s*\/\s*institution name|present employer or school name|employer name|group name/i, 75],
  [/course of study/i, 66],
  [/languages spoken|^language$/i, 66],
  [/clan|tribe/i, 80],
  [/duties|full description|explanation/i, 4000],
  [/passport number|national id|taxpayer/i, 20],
  [/visa number/i, 12],
  [/monthly salary/i, 15],
  [/flight/i, 20],
  [/branch of service|rank\s*\/\s*position|military specialty/i, 40],
  [/social media/i, 50],
]

export function limitForTranslatedLabel(label) {
  const text = String(label ?? '').trim()
  for (const [pattern, max] of TRANSLATED_LABEL_LIMITS) {
    if (pattern.test(text)) return max
  }
  return null
}

export function fitDs160Value(value, max, { city = false } = {}) {
  const original = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!original || MARKER_RE.test(original) || !max || original.length <= max) return original
  if (city) return shortenDs160City(original, max)
  const words = original.split(' ')
  while (words.length > 1 && words.join(' ').length > max) words.pop()
  let text = words.join(' ')
  if (text.length > max) text = text.slice(0, max).trim()
  return text
}

export function fitDs160Phone(value, max = 15) {
  const original = String(value ?? '').trim()
  if (!original || MARKER_RE.test(original) || original.length <= max) return original
  const digits = original.replace(/\D/g, '')
  if (!digits) return original.slice(0, max)
  return digits.length <= max ? digits : digits.slice(0, max)
}

export function shortenCitiesInTranslatedText(translatedText) {
  return clampDs160LimitsInTranslatedText(translatedText)
}

export function clampDs160LimitsInTranslatedText(translatedText) {
  return String(translatedText ?? '')
    .split('\n')
    .map((line) => {
      const colonIndex = line.indexOf(':')
      if (colonIndex < 0) return line
      const label = line.slice(0, colonIndex)
      const max = limitForTranslatedLabel(label)
      if (!max) return line
      const value = line.slice(colonIndex + 1).trim()
      const shortened = /phone|telephone/i.test(label)
        ? fitDs160Phone(value, max)
        : fitDs160Value(value, max, { city: isTranslatedCityLabel(label) })
      if (shortened === value) return line
      return `${line.slice(0, colonIndex + 1)} ${shortened}`
    })
    .join('\n')
}

function limitForSheetKey(key) {
  const name = String(key ?? '')
  if (/city/i.test(name) && /issu/i.test(name)) return 25
  if (/city/i.test(name)) return 20
  if (/state|province/i.test(name)) return /issu/i.test(name) ? 25 : 20
  if (/postal|zip/i.test(name)) return 10
  if (/phone|tel/i.test(name)) return 15
  if (/email/i.test(name)) return 50
  if (/street|addr/i.test(name)) return 40
  if (/surname|given/i.test(name)) return 33
  if (/native/i.test(name)) return 100
  if (/school_name|employer_name|institution|group_name/i.test(name)) return 75
  if (/course/i.test(name)) return 66
  if (/language/i.test(name)) return 66
  if (/clan|tribe/i.test(name)) return 80
  if (/duties|expl/i.test(name)) return 4000
  if (/salary/i.test(name)) return 15
  if (/social/i.test(name)) return 50
  if (/branch|rank|specialty/i.test(name)) return 40
  if (/organization/i.test(name)) return 33
  if (/foil|visa_number|visaNumber/i.test(name)) return 12
  if (/passport|national_id|ppt_num/i.test(name)) return 20
  return null
}

export function shortenCitiesInAnswerSheet(sheet) {
  return clampDs160LimitsInAnswerSheet(sheet)
}

export function clampDs160LimitsInAnswerSheet(sheet) {
  if (!sheet || typeof sheet !== 'object') return sheet
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== 'string') {
        if (value && typeof value === 'object') walk(value)
        continue
      }
      const max = limitForSheetKey(key)
      if (!max) continue
      node[key] = /phone|tel/i.test(key)
        ? fitDs160Phone(value, max)
        : fitDs160Value(value, max, { city: /city/i.test(key) })
    }
  }
  walk(sheet)
  return sheet
}
