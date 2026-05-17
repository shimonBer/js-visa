/**
 * POST driver's license image to /api/extract-us-license.
 * @param {File} file
 * @returns {Promise<{ licenseNumber: string, issuingCountry: string }>}
 */
export async function extractUsLicenseFieldsFromFile(file) {
  if (!(file instanceof File)) {
    throw new Error('Invalid file')
  }
  const mime = file.type || 'application/octet-stream'
  const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
  if (!allowed.test(mime)) {
    throw new Error('Unsupported file type; use JPEG, PNG, GIF, WebP, or PDF')
  }

  const res = await fetch('/api/extract-us-license', {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: file,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(text.slice(0, 300) || `License extract failed (${res.status})`)
  }
  if (!res.ok) {
    throw new Error(json.error || json.detail || text.slice(0, 300) || `License extract failed (${res.status})`)
  }
  return {
    licenseNumber: String(json.licenseNumber ?? '').trim(),
    issuingCountry: String(json.issuingCountry ?? '').trim(),
  }
}
