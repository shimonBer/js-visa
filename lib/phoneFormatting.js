const PHONE_FIELD_RE = /phone|telephone|_TEL\b|AddPhone|EmpPhone|PayerPhone/i
const PHONE_QUESTION_RE = /used any other phone|other phone numbers.*last five years/i
const NON_PHONE_TOKEN_RE =
  /^(?:n\/?a|none|null|nil|unknown|missing|❗\s*missing|does not apply|not applicable)$/i

const SOURCE_PHONE_KEYS = new Set([
  'phoneCountryCode',
  'phoneNumber',
  'secondaryPhone',
  'workPhone',
  'tripPayerPhone',
  'contactPhone',
  'employerPhone',
  'studentInstitutionPhone',
])

export function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '')
}

export function phoneDigitsOrOriginal(value) {
  const raw = String(value ?? '')
  const trimmed = raw.trim()
  if (!trimmed || NON_PHONE_TOKEN_RE.test(trimmed)) return raw
  const digits = phoneDigits(trimmed)
  return digits || raw
}

export function isPhoneNumberField({ label = '', ref = '', fieldLabel = '', key = '' } = {}) {
  const hay = `${label} ${fieldLabel} ${ref} ${key}`
  if (PHONE_QUESTION_RE.test(hay)) return false
  return PHONE_FIELD_RE.test(hay)
}

export function normalizePhoneFillValue(value, meta = {}) {
  if (typeof value !== 'string') return value
  if (!isPhoneNumberField(meta)) return value
  return phoneDigitsOrOriginal(value)
}

/**
 * Strip punctuation from phone-number lines in a translated review document.
 * Yes/No questions that mention phones are left unchanged.
 */
export function normalizePhoneNumbersInTranslatedText(translatedText) {
  return String(translatedText ?? '')
    .split('\n')
    .map((line) => {
      const colonIndex = line.indexOf(':')
      if (colonIndex < 0) return line

      const label = line.slice(0, colonIndex)
      if (!isPhoneNumberField({ label })) return line

      const value = line.slice(colonIndex + 1).trim()
      const normalized = phoneDigitsOrOriginal(value)
      if (normalized === value) return line
      return `${line.slice(0, colonIndex + 1)}${normalized ? ` ${normalized}` : ''}`
    })
    .join('\n')
}

function normalizePhoneKeyedValue(key, value) {
  if (typeof value !== 'string') return value
  if (!isPhoneNumberField({ key })) return value
  return phoneDigitsOrOriginal(value)
}

export function normalizePhoneFieldsInSourceData(source) {
  const data = source && typeof source === 'object' ? source : {}

  for (const key of SOURCE_PHONE_KEYS) {
    if (typeof data[key] === 'string') data[key] = phoneDigitsOrOriginal(data[key])
  }

  if (Array.isArray(data.otherPhones)) {
    data.otherPhones = data.otherPhones.map((row) => (
      row && typeof row === 'object'
        ? { ...row, number: typeof row.number === 'string' ? phoneDigitsOrOriginal(row.number) : row.number }
        : row
    ))
  }

  if (Array.isArray(data.previousEmployments)) {
    data.previousEmployments = data.previousEmployments.map((row) => (
      row && typeof row === 'object'
        ? { ...row, phone: typeof row.phone === 'string' ? phoneDigitsOrOriginal(row.phone) : row.phone }
        : row
    ))
  }

  return data
}

export function normalizePhoneFieldsInAnswerSheet(sheet) {
  if (!sheet || typeof sheet !== 'object') return sheet

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        node[key] = normalizePhoneKeyedValue(key, value)
      } else if (value && typeof value === 'object') {
        walk(value)
      }
    }
  }

  walk(sheet)
  return sheet
}
