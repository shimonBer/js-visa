/**
 * Download / queue name for a translated DS-160 file: first_name_lastname.txt
 */

export function slugNamePart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function namesFromTranslatedText(text) {
  const body = String(text || '')
  const surname = body.match(/^Surname:\s*(.+)$/im)?.[1]?.trim() || ''
  const given = body.match(/^Given Name:\s*(.+)$/im)?.[1]?.trim() || ''
  return { firstName: given, lastName: surname }
}

export function translatedDownloadFileName({ firstName, lastName, translatedText } = {}) {
  let first = slugNamePart(firstName)
  let last = slugNamePart(lastName)
  if ((!first || !last) && translatedText) {
    const parsed = namesFromTranslatedText(translatedText)
    first = first || slugNamePart(parsed.firstName)
    last = last || slugNamePart(parsed.lastName)
  }
  if (first && last) return `${first}_${last}.txt`
  if (last) return `${last}.txt`
  if (first) return `${first}.txt`
  return 'translated.txt'
}
