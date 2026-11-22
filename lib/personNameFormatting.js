const PERSON_NAME_LABEL =
  /\b(?:surnames?|given names?|full name|native name|name of person)\b/i

/**
 * Final safeguard for model output: person-name values must never contain
 * parenthetical aliases. Other field types are left untouched.
 */
export function stripParentheticalAliasesFromPersonNames(translatedText) {
  return String(translatedText ?? '')
    .split('\n')
    .map((line) => {
      const colonIndex = line.indexOf(':')
      if (colonIndex < 0) return line

      const label = line.slice(0, colonIndex)
      if (!PERSON_NAME_LABEL.test(label)) return line

      const value = line
        .slice(colonIndex + 1)
        .replace(/\s*[(（][^)）\n]*[)）]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()

      return `${line.slice(0, colonIndex + 1)}${value ? ` ${value}` : ''}`
    })
    .join('\n')
}

/**
 * Applicant Surname, Given Name, and native full name are whatever the portal
 * saved. The summary model must not append nationality or any other passport
 * word to those lines.
 * @param {string} translatedText
 * @param {{ surname?: string, givenName?: string, nativeName?: string }} names
 */
export function lockApplicantNamesFromPortal(translatedText, names = {}) {
  let text = String(translatedText ?? '')
  const surname = String(names.surname ?? '').trim()
  const givenName = String(names.givenName ?? '').trim()
  const nativeName = String(names.nativeName ?? '').trim()
  if (surname) text = replaceFirstLabeledLine(text, 'Surname', surname)
  if (givenName) text = replaceFirstLabeledLine(text, 'Given Name', givenName)
  if (nativeName) text = replaceFirstLabeledLine(text, 'Full Name in Native Alphabet', nativeName)
  return text
}

function replaceFirstLabeledLine(text, label, value) {
  const pattern = new RegExp(`^([ \\t]*(?:[-*•][ \\t]*)?)${label}:[ \\t]*.*$`, 'm')
  if (!pattern.test(text)) return text
  return text.replace(pattern, `$1${label}: ${value}`)
}
