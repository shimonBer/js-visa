/**
 * POST JSON to n8n (or any) webhook. URLs must be listed in Vite env (VITE_*).
 *
 * Security: anything in VITE_* is visible in the client bundle. Treat webhook URLs
 * as capability tokens (n8n’s long random production URL). Do not put true secrets in VITE_*.
 */

function resolveWebhookUrl(kind) {
  if (kind === 'draft') {
    return import.meta.env.VITE_N8N_DRAFT_WEBHOOK_URL || import.meta.env.VITE_N8N_WEBHOOK_URL || ''
  }
  if (kind === 'submit') {
    return import.meta.env.VITE_N8N_SUBMIT_WEBHOOK_URL || import.meta.env.VITE_N8N_WEBHOOK_URL || ''
  }
  return ''
}

function optionalAuthHeaders() {
  const name = import.meta.env.VITE_N8N_WEBHOOK_HEADER_NAME
  const value = import.meta.env.VITE_N8N_WEBHOOK_HEADER_VALUE
  if (name && value) return { [String(name)]: String(value) }
  return {}
}

/**
 * @param {'draft' | 'submit'} kind
 * @param {Record<string, unknown>} body JSON-serializable
 */
export async function postFormToN8n(kind, body) {
  const url = resolveWebhookUrl(kind)
  if (!url) {
    throw new Error(
      kind === 'draft'
        ? 'חסרה כתובת Webhook: הגדר VITE_N8N_WEBHOOK_URL או VITE_N8N_DRAFT_WEBHOOK_URL ב-Vercel'
        : 'חסרה כתובת Webhook: הגדר VITE_N8N_WEBHOOK_URL או VITE_N8N_SUBMIT_WEBHOOK_URL ב-Vercel',
    )
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...optionalAuthHeaders(),
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`n8n / webhook החזיר ${res.status}: ${text.slice(0, 500)}`)
  }
  return { status: res.status, text }
}
