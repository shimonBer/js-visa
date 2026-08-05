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
