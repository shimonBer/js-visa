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
const MAX_PER_FILE = 2 * 1024 * 1024

/**
 * Sends form field JSON + optional document images to /api/translate-form.
 * @param {Record<string, unknown>} values react-hook-form values (may include File fields)
 * @returns {Promise<string>} translated English text
 */
export async function translateFormToEnglish(values) {
  const { data, fileMeta } = serializeFormValuesForJson(values)

  /** @type {{ field: string, fileName: string, mimeType: string, base64: string }[]} */
  const attachments = []
  for (const field of DOC_FIELDS) {
    const f = firstFile(values[field])
    if (!(f instanceof File)) continue
    if (f.size > MAX_PER_FILE) {
      throw new Error(`קובץ ${field} גדול מדי (מקסימום 2MB לתרגום)`)
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
  return String(json.translated ?? '')
}
