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
