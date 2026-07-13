import { resizeImageFile } from './resizeImage.js'

/**
 * POST a foreign passport image to /api/extract-passport?mode=foreign.
 * Returns the passport number cross-checked between the visual field and MRZ.
 * @param {File} file
 * @returns {Promise<{ passportNumber: string|null, matched: boolean }>}
 */
export async function extractForeignPassportNumber(file) {
  if (!(file instanceof File)) throw new Error('Invalid file')

  const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
  if (!allowed.test(file.type || '')) throw new Error('Unsupported file type; use JPEG, PNG, GIF, WebP, or PDF')

  const resized = await resizeImageFile(file)
  const mime = resized.type || 'image/jpeg'

  const res = await fetch('/api/extract-passport?mode=foreign', {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: resized,
  })

  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch {
    throw new Error(text.slice(0, 300) || `Foreign passport extract failed (${res.status})`)
  }
  if (!res.ok) {
    throw new Error(json.error || json.detail || text.slice(0, 300) || `Foreign passport extract failed (${res.status})`)
  }

  return {
    passportNumber: json.passportNumber ?? null,
    matched: json.matched ?? false,
  }
}
