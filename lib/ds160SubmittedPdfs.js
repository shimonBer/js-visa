/** Canonical S3 object names for CEAC confirmation + Print Application PDFs. */

import { applicantFilePrefix } from './translatedFileName.js'

export const DS160_CONFIRMATION_FIELD = 'ds160ConfirmationPdf'
export const DS160_APPLICATION_FIELD = 'ds160ApplicationPdf'
export const DS160_CONFIRMATION_FILE = 'ds160-confirmation.pdf'
export const DS160_APPLICATION_FILE = 'ds160-application.pdf'

export const DS160_SUBMITTED_PDF_FIELDS = [
  DS160_CONFIRMATION_FIELD,
  DS160_APPLICATION_FIELD,
]

/**
 * `shira_lorentz_reiner_ds160-confirmation.pdf` when a name is known.
 * The unprefixed name stays the fallback so older uploads still resolve.
 * @param {string} baseFile
 * @param {{ firstName?: string, lastName?: string, translatedText?: string }} [nameOptions]
 */
export function ds160SubmittedPdfFileName(baseFile, nameOptions) {
  const prefix = applicantFilePrefix(nameOptions)
  return prefix ? `${prefix}_${baseFile}` : baseFile
}

function submittedPdfKind(fileName) {
  const name = String(fileName || '').trim().toLowerCase()
  if (name === DS160_CONFIRMATION_FILE || name.endsWith(`_${DS160_CONFIRMATION_FILE}`)) return 'confirmation'
  if (name === DS160_APPLICATION_FILE || name.endsWith(`_${DS160_APPLICATION_FILE}`)) return 'application'
  return ''
}

/**
 * @param {string} formId
 * @param {{ firstName?: string, lastName?: string, translatedText?: string }} [nameOptions]
 * @returns {{ field: string, fileName: string, key: string }[]}
 */
export function ds160SubmittedPdfKeys(formId, nameOptions) {
  const id = String(formId || '').trim()
  if (!id) return []
  const confirmationFile = ds160SubmittedPdfFileName(DS160_CONFIRMATION_FILE, nameOptions)
  const applicationFile = ds160SubmittedPdfFileName(DS160_APPLICATION_FILE, nameOptions)
  return [
    {
      field: DS160_CONFIRMATION_FIELD,
      fileName: confirmationFile,
      key: `${id}/${confirmationFile}`,
    },
    {
      field: DS160_APPLICATION_FIELD,
      fileName: applicationFile,
      key: `${id}/${applicationFile}`,
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
  return Boolean(submittedPdfKind(fileName))
}

export function siblingDs160SubmittedPdfFileName(fileName) {
  const name = String(fileName || '').trim()
  const kind = submittedPdfKind(name)
  if (kind === 'confirmation') return name.replace(/ds160-confirmation\.pdf$/i, DS160_APPLICATION_FILE)
  if (kind === 'application') return name.replace(/ds160-application\.pdf$/i, DS160_CONFIRMATION_FILE)
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
    const fromKey = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    const fileName = isDs160SubmittedPdfFileName(fromKey)
      ? fromKey
      : (conventional.get(field)?.fileName || fromKey)
    byField.set(field, { field, key, fileName })
  }
  return [...byField.values()]
}
