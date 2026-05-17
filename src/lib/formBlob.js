/**
 * Server-side Vercel Blob storage for full form JSON (via /api/form-blob).
 * Requires BLOB_READ_WRITE_TOKEN on the deployment linked to store (e.g. js-visa-blob).
 */

export async function saveFormBlobPayload(payload) {
  const res = await fetch('/api/form-blob', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(text.slice(0, 400) || `Blob save failed (${res.status})`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return { ok: true }
  }
}

export async function listFormBlobsFromApi() {
  const res = await fetch('/api/form-blob')
  const text = await res.text()
  if (!res.ok) {
    throw new Error(text.slice(0, 400) || `List failed (${res.status})`)
  }
  return JSON.parse(text)
}

export async function fetchFormBlobPayload(pathname) {
  const res = await fetch(`/api/form-blob?pathname=${encodeURIComponent(pathname)}`)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(text.slice(0, 400) || `Load failed (${res.status})`)
  }
  return JSON.parse(text)
}

/**
 * Deletes the form JSON blob and any S3 objects listed in its `s3Documents` array.
 * Same-origin POST `/api/delete-form` (requires `vercel dev` or production).
 *
 * @param {string} pathname — e.g. `forms/shimi_berko_123_2026-05-09.json`
 * @returns {Promise<{ ok: boolean, pathname: string, s3Deleted: string[], s3Errors: { key: string, error: string }[] }>}
 */
export async function deleteFormFromCloud(pathname) {
  const res = await fetch('/api/delete-form', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pathname }),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(text.slice(0, 400) || `Delete failed (${res.status})`)
  }
  if (!res.ok) {
    throw new Error(json.error || text.slice(0, 400) || `Delete failed (${res.status})`)
  }
  return json
}
