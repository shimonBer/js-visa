/**
 * POST a foreign passport image to /api/extract-foreign-passport.
 * Returns the passport number cross-checked between the visual field and MRZ.
 * @param {File} file
 * @returns {Promise<{ passportNumber: string|null, matched: boolean }>}
 */
export async function extractForeignPassportNumber(file) {
  if (!(file instanceof File)) throw new Error('Invalid file')

  const mime = file.type || 'application/octet-stream'
  const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
  if (!allowed.test(mime)) throw new Error('Unsupported file type; use JPEG, PNG, GIF, WebP, or PDF')

  const res = await fetch('/api/extract-passport?mode=foreign', {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: file,
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
