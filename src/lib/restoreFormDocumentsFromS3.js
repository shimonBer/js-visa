import { getS3UploadApiBase } from './uploadFormDocuments.js'

const DOCUMENT_FIELDS = new Set([
  'passportScan',
  'existingVisaScan',
  'socialSecurityScan',
  'americanLicenseScan',
])

/**
 * Fetches previously uploaded S3 objects and sets RHF file fields (DataTransfer FileList).
 * @param {unknown} s3Documents — array of { field, key } from saved draft/blob
 * @param {(name: string, value: FileList, opts?: object) => void} setValue
 * @returns {Promise<{ restored: number, failed: number }>}
 */
export async function restoreS3DocumentsIntoForm(s3Documents, setValue) {
  const base = getS3UploadApiBase()
  if (!base || !Array.isArray(s3Documents) || s3Documents.length === 0) {
    return { restored: 0, failed: 0 }
  }

  let restored = 0
  let failed = 0
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  for (const doc of s3Documents) {
    const field = doc && typeof doc.field === 'string' ? doc.field : ''
    const key = doc && typeof doc.key === 'string' ? doc.key : ''
    if (!DOCUMENT_FIELDS.has(field) || !key) continue

    try {
      const u = new URL(base, origin || 'http://localhost')
      u.searchParams.set('key', key)
      const res = await fetch(u.toString(), { method: 'GET' })
      if (!res.ok) {
        failed += 1
        continue
      }
      const blob = await res.blob()
      const fileName = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
      const file = new File([blob], fileName || 'document.bin', {
        type: blob.type || 'application/octet-stream',
      })
      const dt = new DataTransfer()
      dt.items.add(file)
      setValue(field, dt.files, { shouldValidate: false, shouldDirty: false })
      restored += 1
    } catch (e) {
      console.warn('[restoreS3Documents]', field, e)
      failed += 1
    }
  }

  return { restored, failed }
}
