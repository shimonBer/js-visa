/** Canonical S3 object names for CEAC confirmation + Print Application PDFs. */

export const DS160_CONFIRMATION_FIELD = 'ds160ConfirmationPdf'
export const DS160_APPLICATION_FIELD = 'ds160ApplicationPdf'
export const DS160_CONFIRMATION_FILE = 'ds160-confirmation.pdf'
export const DS160_APPLICATION_FILE = 'ds160-application.pdf'

export const DS160_SUBMITTED_PDF_FIELDS = [
  DS160_CONFIRMATION_FIELD,
  DS160_APPLICATION_FIELD,
]

/**
 * @param {string} formId
 * @returns {{ field: string, fileName: string, key: string }[]}
 */
export function ds160SubmittedPdfKeys(formId) {
  const id = String(formId || '').trim()
  if (!id) return []
  return [
    {
      field: DS160_CONFIRMATION_FIELD,
      fileName: DS160_CONFIRMATION_FILE,
      key: `${id}/${DS160_CONFIRMATION_FILE}`,
    },
    {
      field: DS160_APPLICATION_FIELD,
      fileName: DS160_APPLICATION_FILE,
      key: `${id}/${DS160_APPLICATION_FILE}`,
    },
  ]
}

/** Local bridge / CLI: POST PDFs through the same /api/upload the portal uses. */
export function resolveS3UploadApiUrl(env = process.env) {
  return (
    String(env.S3_UPLOAD_API_URL || '').trim() ||
    String(env.VITE_S3_UPLOAD_API_URL || '').trim() ||
    ''
  )
}

export function isDs160SubmittedPdfField(field) {
  return DS160_SUBMITTED_PDF_FIELDS.includes(String(field || ''))
}

export function isDs160SubmittedPdfFileName(fileName) {
  const name = String(fileName || '').trim()
  return name === DS160_CONFIRMATION_FILE || name === DS160_APPLICATION_FILE
}

export function siblingDs160SubmittedPdfFileName(fileName) {
  const name = String(fileName || '').trim()
  if (name === DS160_CONFIRMATION_FILE) return DS160_APPLICATION_FILE
  if (name === DS160_APPLICATION_FILE) return DS160_CONFIRMATION_FILE
  return null
}

/** Both CEAC confirmation and Print Application PDFs must be present. */
export function hasDs160AutofillSuccess(s3Documents, formId) {
  const fields = new Set(
    submittedPdfsFromDocuments(s3Documents, formId).map((doc) => doc.field),
  )
  return DS160_SUBMITTED_PDF_FIELDS.every((field) => fields.has(field))
}

export function pathnameMatchesFormId(pathname, formId) {
  const id = String(formId || '').trim()
  return Boolean(id) && String(pathname || '').endsWith(`_${id}.json`)
}

/**
 * @param {unknown} s3Documents
 * @param {string} formId
 * @returns {{ field: string, key: string, fileName: string }[]}
 */
export function submittedPdfsFromDocuments(s3Documents, formId) {
  const byField = new Map()
  const conventional = new Map(ds160SubmittedPdfKeys(formId).map((item) => [item.field, item]))
  for (const doc of Array.isArray(s3Documents) ? s3Documents : []) {
    const field = doc && typeof doc.field === 'string' ? doc.field : ''
    const key = doc && typeof doc.key === 'string' ? doc.key : ''
    if (!isDs160SubmittedPdfField(field) || !key) continue
    const fileName = conventional.get(field)?.fileName
      || (key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key)
    byField.set(field, { field, key, fileName })
  }
  return [...byField.values()]
}
