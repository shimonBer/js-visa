import { resizeImageFile } from './resizeImage.js'

/**
 * POST passport image bytes to /api/extract-passport (same origin; use vercel dev locally).
 * @param {File} file
 * @returns {Promise<{ firstName: string, lastName: string, birthDate: string, birthCountry: string, passportNumber: string, issuingCountry: string, sex: string, nationalId: string, passportIssueDate: string, passportExpirationDate: string, issuanceCity: string, issuanceCountry: string }>}
 */
export async function extractPassportFieldsFromFile(file) {
  if (!(file instanceof File)) {
    throw new Error('Invalid file')
  }
  const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
  if (!allowed.test(file.type || '')) {
    throw new Error('Unsupported file type; use JPEG, PNG, GIF, WebP, or PDF')
  }

  const resized = await resizeImageFile(file)
  const mime = resized.type || 'image/jpeg'

  const res = await fetch('/api/extract-passport', {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: resized,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(text.slice(0, 300) || `Passport extract failed (${res.status})`)
  }
  if (!res.ok) {
    throw new Error(json.error || json.detail || text.slice(0, 300) || `Passport extract failed (${res.status})`)
  }
  return {
    firstName: String(json.firstName ?? ''),
    lastName: String(json.lastName ?? ''),
    birthDate: String(json.birthDate ?? ''),
    birthCountry: String(json.placeOfBirth ?? '').trim(),
    passportNumber: String(json.passportNumber ?? ''),
    issuingCountry: String(json.issuingCountry ?? json.country ?? ''),
    sex: String(json.sex ?? '').trim().toUpperCase().slice(0, 1),
    nationalId: String(json.nationalId ?? '').trim(),
    passportBookNumber: String(json.passportBookNumber ?? '').trim(),
    passportIssueDate: String(json.dateOfIssue ?? '').trim(),
    passportExpirationDate: String(json.dateOfExpiry ?? '').trim(),
    issuanceCity: String(json.issuanceCity ?? '').trim(),
    issuanceCountry: String(json.issuanceCountry ?? '').trim(),
  }
}
