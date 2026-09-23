/** One translation PDF per form. A new translation overwrites this object. */

export const TRANSLATION_PDF_FIELD = 'translationPdf'
export const TRANSLATION_PDF_FILE = 'translation.pdf'

/**
 * @param {string} formId
 * @returns {string} `{formId}/translation.pdf`, or '' when the id cannot be an S3 key
 */
export function translationPdfKey(formId) {
  const id = String(formId || '').trim()
  if (!id || id.length > 120 || !/^[a-zA-Z0-9_-]+$/.test(id)) return ''
  return `${id}/${TRANSLATION_PDF_FILE}`
}
