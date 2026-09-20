import { authHeaders } from './auth.js'
import { getS3UploadApiBase } from './uploadFormDocuments.js'
import { ds160SubmittedPdfKeys } from '../../lib/ds160SubmittedPdfs.js'

export {
  DS160_APPLICATION_FIELD,
  DS160_APPLICATION_FILE,
  DS160_CONFIRMATION_FIELD,
  DS160_CONFIRMATION_FILE,
  DS160_SUBMITTED_PDF_FIELDS,
  ds160SubmittedPdfKeys,
  isDs160SubmittedPdfField,
  submittedPdfsFromDocuments,
} from '../../lib/ds160SubmittedPdfs.js'

function uploadUrl(key, extra = {}) {
  const base = getS3UploadApiBase()
  if (!base || !key) return null
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
  const u = new URL(base, origin)
  u.searchParams.set('key', key)
  for (const [name, value] of Object.entries(extra)) {
    if (value != null && value !== '') u.searchParams.set(name, String(value))
  }
  return u.toString()
}

/**
 * @param {string} formId
 * @returns {Promise<{ field: string, key: string, fileName: string }[]>}
 */
export async function probeDs160SubmittedPdfs(formId) {
  const items = ds160SubmittedPdfKeys(formId)
  if (!getS3UploadApiBase() || items.length === 0) return []

  const found = []
  await Promise.all(
    items.map(async (item) => {
      const url = uploadUrl(item.key, { exists: '1' })
      if (!url) return
      try {
        const res = await fetch(url, { method: 'GET', headers: authHeaders() })
        if (!res.ok) return
        const body = await res.json().catch(() => ({}))
        if (body?.exists === false) return
        found.push({ field: item.field, key: item.key, fileName: item.fileName })
      } catch {
        /* missing or unreachable */
      }
    }),
  )
  return found
}

/**
 * @param {string} key
 * @param {string} fileName
 */
export async function downloadS3FormDocument(key, fileName) {
  const url = uploadUrl(key, { download: '1' })
  if (!url) throw new Error('S3 download is not configured')
  const res = await fetch(url, { method: 'GET', headers: authHeaders() })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text.slice(0, 200) || `Download failed (${res.status})`)
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = fileName || 'document.pdf'
  a.click()
  URL.revokeObjectURL(href)
}
