import { getS3UploadApiBase, S3_DOCUMENTS_BUCKET } from './uploadFormDocuments.js'
import {
  TRANSLATION_PDF_FIELD,
  TRANSLATION_PDF_FILE,
  translationPdfKey,
} from '../../lib/translationPdf.js'

export { TRANSLATION_PDF_FIELD, TRANSLATION_PDF_FILE, translationPdfKey }

function bytesFromBase64(pdfBase64) {
  const clean = String(pdfBase64 || '')
    .replace(/\s/g, '')
    .replace(/^data:application\/pdf;base64,/, '')
  if (!clean) return null
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Uploads the translation PDF to `{formId}/translation.pdf`, replacing any previous one.
 * @param {string} formId
 * @param {string} pdfBase64
 * @returns {Promise<{ field: string, key: string, bucket: string } | null>}
 */
export async function uploadTranslationPdf(formId, pdfBase64) {
  const key = translationPdfKey(formId)
  const base = getS3UploadApiBase()
  const bytes = bytesFromBase64(pdfBase64)
  if (!key || !base || !bytes?.length) return null
  const id = key.slice(0, key.indexOf('/'))
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Form-Id': id,
      'X-File-Name': TRANSLATION_PDF_FILE,
    },
    body: bytes,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text.slice(0, 200) || `PDF upload failed (${res.status})`)
  }
  const json = await res.json().catch(() => ({}))
  return {
    field: TRANSLATION_PDF_FIELD,
    key: typeof json.key === 'string' && json.key ? json.key : key,
    bucket: typeof json.bucket === 'string' && json.bucket ? json.bucket : S3_DOCUMENTS_BUCKET,
  }
}

/**
 * Downloads the saved translation PDF. Empty string when it is not in the bucket yet.
 * @param {string} formId
 */
export async function fetchTranslationPdfBase64(formId) {
  const key = translationPdfKey(formId)
  const base = getS3UploadApiBase()
  if (!key || !base || typeof window === 'undefined') return ''
  const url = new URL(base, window.location.origin)
  url.searchParams.set('key', key)
  const res = await fetch(url.toString())
  if (!res.ok) return ''
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (!bytes.length) return ''
  return bytesToBase64(bytes)
}

/** @param {string} pdfBase64 @param {string} [fileName] */
export function downloadPdfBase64(pdfBase64, fileName = 'ds160-english-summary.pdf') {
  const bytes = bytesFromBase64(pdfBase64)
  if (!bytes?.length) return false
  const blob = new Blob([bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
  return true
}
