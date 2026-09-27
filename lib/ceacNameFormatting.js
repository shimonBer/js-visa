/**
 * CEAC "name" fields (employer, school, organization, group, job title) accept
 * only A-Z, 0-9, hyphen, apostrophe, ampersand, and single spaces. A trailing
 * period in "Elbit Systems Ltd." is the usual live failure.
 */

const MARKER_RE =
  /^(?:n\/?a|none|null|nil|unknown|missing|❗\s*missing|does not apply|not applicable|do not know)$/i

const CEAC_NAME_LABEL_RE =
  /^(?:present\s+)?(?:employer(?:\s+or\s+school)?\s+name|school\s*\/?\s*institution\s+name|name of institution|organization name|group name|job title(?:\s*\/\s*position)?)\b/i

const CEAC_NAME_REF_RE =
  /tbxEmpName|tbxEmpSchName|tbxSchoolName|tbxUS_POC_ORGANIZATION|tbxORGANIZATION_NAME|tbxGroupName|tbxEmpJobTitle/i

const CEAC_NAME_KEY_RE =
  /^(?:employerName|studentInstitutionName|institutionName|contactOrganization|jobTitle|groupName|organizationName)$/i

export function isCeacNameField({ label = '', ref = '', fieldLabel = '', key = '' } = {}) {
  const labeled = `${label} ${fieldLabel}`.trim()
  if (CEAC_NAME_LABEL_RE.test(labeled)) return true
  if (CEAC_NAME_REF_RE.test(String(ref))) return true
  if (CEAC_NAME_KEY_RE.test(String(key))) return true
  return false
}

export function sanitizeCeacName(value) {
  const raw = String(value ?? '')
  const trimmed = raw.trim()
  if (!trimmed || MARKER_RE.test(trimmed)) return raw
  return trimmed
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\./g, '')
    .replace(/[^A-Za-z0-9 \-'&]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/^[-'&]+|[-'&]+$/g, '')
    .trim()
}

export function ceacNameNeedsRewrite(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || MARKER_RE.test(trimmed)) return false
  return sanitizeCeacName(trimmed) !== trimmed
}

export function normalizeCeacNameFillValue(value, meta = {}) {
  if (typeof value !== 'string') return value
  if (!isCeacNameField(meta)) return value
  return sanitizeCeacName(value)
}

export function normalizeCeacNamesInTranslatedText(translatedText) {
  return String(translatedText ?? '')
    .split('\n')
    .map((line) => {
      const colonIndex = line.indexOf(':')
      if (colonIndex < 0) return line
      const label = line.slice(0, colonIndex)
      if (!isCeacNameField({ label })) return line
      const value = line.slice(colonIndex + 1).trim()
      const normalized = sanitizeCeacName(value)
      if (normalized === value) return line
      return `${line.slice(0, colonIndex + 1)}${normalized ? ` ${normalized}` : ''}`
    })
    .join('\n')
}

function normalizeKeyed(key, value) {
  if (typeof value !== 'string') return value
  if (!isCeacNameField({ key })) return value
  return sanitizeCeacName(value)
}

export function normalizeCeacNameFieldsInSourceData(source) {
  const data = source && typeof source === 'object' ? source : {}

  for (const key of [
    'employerName',
    'studentInstitutionName',
    'contactOrganization',
    'jobTitle',
  ]) {
    if (typeof data[key] === 'string') data[key] = sanitizeCeacName(data[key])
  }

  if (Array.isArray(data.previousEmployments)) {
    data.previousEmployments = data.previousEmployments.map((row) => (
      row && typeof row === 'object'
        ? {
            ...row,
            employerName: typeof row.employerName === 'string'
              ? sanitizeCeacName(row.employerName)
              : row.employerName,
            jobTitle: typeof row.jobTitle === 'string'
              ? sanitizeCeacName(row.jobTitle)
              : row.jobTitle,
          }
        : row
    ))
  }

  if (Array.isArray(data.educationRecords)) {
    data.educationRecords = data.educationRecords.map((row) => (
      row && typeof row === 'object'
        ? {
            ...row,
            institutionName: typeof row.institutionName === 'string'
              ? sanitizeCeacName(row.institutionName)
              : row.institutionName,
          }
        : row
    ))
  }

  return data
}

export function normalizeCeacNameFieldsInAnswerSheet(sheet) {
  if (!sheet || typeof sheet !== 'object') return sheet

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') node[key] = normalizeKeyed(key, value)
      else if (value && typeof value === 'object') walk(value)
    }
  }

  walk(sheet)
  return sheet
}
