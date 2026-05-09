/** Target bucket for DS-160 document uploads (must match server `S3_BUCKET` default) */
export const S3_DOCUMENTS_BUCKET = 'js_visa'

/**
 * Same-origin POST /api/upload in production. Files are sent to the server; the server
 * writes to S3 using AWS_* env vars (Vercel). Never put access keys in VITE_*.
 * Dev: no upload unless VITE_S3_UPLOAD_API_URL points at a running API (e.g. `vercel dev`).
 */
function resolveUploadApiBase(opts) {
  if (opts.uploadUrl) return opts.uploadUrl
  const explicit = import.meta.env.VITE_S3_UPLOAD_API_URL
  if (explicit) return explicit
  if (import.meta.env.PROD) return '/api/upload'
  return ''
}

/**
 * @param {FileList|File|null|undefined} value
 * @returns {File|null}
 */
export function firstFile(value) {
  if (!value) return null
  if (value instanceof File) return value
  if (typeof value === 'object' && 'length' in value && value.length > 0) return value[0]
  return null
}

/**
 * Uploads files via POST to the server; server pushes to S3 with credentials from env.
 *
 * @param {string} formId
 * @param {{ name: string, file: File|null }[]} items
 * @param {{ uploadUrl?: string }} [opts]
 * @returns {Promise<{ field: string, bucket: string, key: string }[]>}
 */
export async function uploadFormDocumentsToS3(formId, items, opts = {}) {
  const base = resolveUploadApiBase(opts)
  if (!base) return []

  const results = []
  for (const { name, file } of items) {
    if (!(file instanceof File)) continue

    const ext = (file.name?.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const fileName = `${name}.${ext}`.slice(0, 180)
    const contentType = file.type || 'application/octet-stream'

    const uploadRes = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-Form-Id': formId,
        'X-File-Name': fileName,
      },
      body: file,
    })

    if (!uploadRes.ok) {
      const text = await uploadRes.text()
      const builtin = base === '/api/upload' || base.endsWith('/api/upload')
      if (builtin && uploadRes.status === 503) {
        try {
          const j = JSON.parse(text)
          if (j.code === 'S3_DISABLED') return []
        } catch {
          /* fall through */
        }
      }
      throw new Error(`Upload failed (${uploadRes.status}): ${text}`)
    }

    const { key, bucket } = await uploadRes.json()
    results.push({ field: name, bucket: bucket || S3_DOCUMENTS_BUCKET, key })
  }
  return results
}
