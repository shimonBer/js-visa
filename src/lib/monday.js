/**
 * Browser client for POST /api/monday (Vercel serverless).
 * Secrets stay on the server; this module only sends applicant name + PDF base64.
 */

/**
 * Full URL or path to the Monday integration handler (POST).
 * Production: `/api/monday`. Local: set `VITE_MONDAY_API_URL` to e.g. `http://localhost:3000/api/monday` when using `vercel dev`.
 *
 * @param {{ apiBase?: string }} [opts]
 * @returns {string}
 */
export function getMondayApiBase(opts = {}) {
  if (opts.apiBase) return String(opts.apiBase).replace(/\/$/, '')
  const explicit = import.meta.env.VITE_MONDAY_API_URL
  if (explicit) return String(explicit).replace(/\/$/, '')
  if (import.meta.env.PROD) return '/api/monday'
  return ''
}

/**
 * Send the DS-160 translation PDF to Monday (creates item + uploads file).
 *
 * @param {object} payload
 * @param {string} payload.applicantName
 * @param {string} payload.pdfBase64
 * @param {string} [payload.status]
 * @param {Record<string, unknown>} [payload.metadata]
 * @param {{ apiBase?: string }} [opts]
 * @returns {Promise<{ success: boolean, itemId: string, fileUpload: Record<string, unknown> }>}
 */
export async function sendPdfToMonday(payload, opts = {}) {
  const postUrl = getMondayApiBase(opts)
  if (!postUrl) {
    throw new Error(
      'Monday API URL is not configured. Use production build, `vercel dev`, or set VITE_MONDAY_API_URL.',
    )
  }

  const res = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      applicantName: payload.applicantName,
      pdfBase64: payload.pdfBase64,
      ...(payload.status != null && payload.status !== '' ? { status: payload.status } : {}),
      ...(payload.metadata && typeof payload.metadata === 'object' ? { metadata: payload.metadata } : {}),
    }),
  })

  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Monday API returned invalid JSON (${res.status}): ${text.slice(0, 200)}`)
  }

  if (!res.ok || json.success === false) {
    const err = typeof json.error === 'string' ? json.error : `Request failed (${res.status})`
    throw new Error(err)
  }

  if (json.success !== true || typeof json.itemId !== 'string' || !json.fileUpload || typeof json.fileUpload !== 'object') {
    throw new Error('Monday API returned an unexpected success payload')
  }

  return {
    success: true,
    itemId: json.itemId,
    fileUpload: /** @type {Record<string, unknown>} */ (json.fileUpload),
  }
}
