/** Target bucket for DS-160 document uploads (must match server `S3_BUCKET` default) */
export const S3_DOCUMENTS_BUCKET = 'js_visa'

/**
 * Presign endpoint: external URL, or built-in `/api/presign` on Vercel (AWS keys server-side only).
 * Dev (`vite`): no URL unless `VITE_S3_PRESIGN_API_URL` points at a running API (e.g. `vercel dev`).
 */
function resolvePresignBase(opts) {
  if (opts.presignUrl) return opts.presignUrl
  const explicit = import.meta.env.VITE_S3_PRESIGN_API_URL
  if (explicit) return explicit
  if (import.meta.env.PROD) return '/api/presign'
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
 * Uploads files to S3 via a presign POST. Production uses `/api/presign` unless `VITE_S3_PRESIGN_API_URL` is set.
 * AWS credentials belong in Vercel env for the API route only — never use VITE_* for secrets.
 *
 * @param {string} formId
 * @param {{ name: string, file: File|null }[]} items
 * @param {{ presignUrl?: string }} [opts]
 * @returns {Promise<{ field: string, bucket: string, key: string }[]>}
 */
export async function uploadFormDocumentsToS3(formId, items, opts = {}) {
  const presignBase = resolvePresignBase(opts)
  if (!presignBase) return []

  const results = []
  for (const { name, file } of items) {
    if (!(file instanceof File)) continue

    const ext = (file.name?.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const fileName = `${name}.${ext}`.slice(0, 180)

    const presignRes = await fetch(presignBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formId,
        fileName,
        contentType: file.type || 'application/octet-stream',
      }),
    })

    if (!presignRes.ok) {
      const text = await presignRes.text()
      const builtin =
        presignBase === '/api/presign' || presignBase.endsWith('/api/presign')
      if (builtin && presignRes.status === 503) {
        try {
          const j = JSON.parse(text)
          if (j.code === 'S3_DISABLED') return []
        } catch {
          /* fall through */
        }
      }
      throw new Error(`Presign failed (${presignRes.status}): ${text}`)
    }

    const { url, key, bucket } = await presignRes.json()
    const contentType = file.type || 'application/octet-stream'
    const putRes = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': contentType },
    })

    if (!putRes.ok) {
      const text = await putRes.text().catch(() => '')
      throw new Error(`S3 upload failed (${putRes.status}) for ${key}: ${text}`)
    }

    results.push({ field: name, bucket: bucket || S3_DOCUMENTS_BUCKET, key })
  }
  return results
}
