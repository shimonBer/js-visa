import { firstFile } from './uploadFormDocuments.js'
import { serializeFormValuesForJson } from './serializeFormPayload.js'

/**
 * Read a File as base64 (no data: prefix).
 * @param {File} file
 */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const r = String(reader.result || '')
      const idx = r.indexOf(',')
      resolve(idx >= 0 ? r.slice(idx + 1) : r)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

const DOC_FIELDS = ['passportScan', 'existingVisaScan', 'socialSecurityScan', 'americanLicenseScan']
const MAX_PER_FILE = 4 * 1024 * 1024

/**
 * Sends form field JSON + optional document images to /api/translate-form.
 * @param {Record<string, unknown>} values react-hook-form values (may include File fields)
 * @param {{ s3Documents?: { field: string, key: string, bucket?: string }[] }} [opts] — merged S3 keys from last save so the server can load bytes for vision + PDF when File blobs are missing
 * @returns {Promise<{ translated: string, attachmentLabels: string[], pdfBase64: string }>}
 */
export async function translateFormToEnglish(values, opts = {}) {
  const { data, fileMeta } = serializeFormValuesForJson(values)
  const s3Documents = Array.isArray(opts.s3Documents) ? opts.s3Documents : []

  /** @type {{ field: string, fileName: string, mimeType: string, base64: string }[]} */
  const attachments = []
  for (const field of DOC_FIELDS) {
    const f = firstFile(values[field])
    if (!(f instanceof File)) continue
    if (f.size > MAX_PER_FILE) {
      throw new Error(`קובץ ${field} גדול מדי (מקסימום 4MB לתרגום)`)
    }
    attachments.push({
      field,
      fileName: f.name,
      mimeType: f.type || 'application/octet-stream',
      base64: await readFileAsBase64(f),
    })
  }

  const res = await fetch('/api/translate-form', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data,
      fileMeta,
      attachments,
      s3Documents,
    }),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(text.slice(0, 400) || `Translate failed (${res.status})`)
  }
  if (!res.ok) {
    throw new Error(json.error || json.detail || `Translate failed (${res.status})`)
  }
  const translated = String(json.translated ?? '')
  const raw = Array.isArray(json.analyzedAttachments) ? json.analyzedAttachments : []
  const attachmentLabels = raw
    .map((a) => {
      const field = String(a?.field ?? '').trim()
      const fileName = String(a?.fileName ?? '').trim()
      if (!field && !fileName) return ''
      if (!field) return fileName
      if (!fileName) return field
      return `${field}: ${fileName}`
    })
    .filter(Boolean)

  const pdfBase64 = typeof json.pdfBase64 === 'string' ? json.pdfBase64 : ''

  return { translated, attachmentLabels, pdfBase64 }
}
