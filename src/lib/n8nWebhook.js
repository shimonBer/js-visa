/**
 * POST JSON to n8n: optional webhook URL(s) and/or HTTP API base VITE_N8N_URL → POST …/form/:form_id.
 *
 * Security: anything in VITE_* is visible in the client bundle. Treat URLs as capability tokens.
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

/** Base URL only (no path). Same role as N8N_URL in env docs — use VITE_N8N_URL so Vite exposes it in the browser. */
function resolveN8nBaseUrl() {
  return String(import.meta.env.VITE_N8N_URL ?? '').trim().replace(/\/+$/, '')
}

/**
 * @param {Record<string, unknown>} body Must include formId when built via buildN8nBody (passportId_date or null).
 */
function resolveFormHttpUrl(body) {
  const base = resolveN8nBaseUrl()
  if (!base) return ''
  const fid =
    body.formId != null && String(body.formId).trim() !== ''
      ? String(body.formId).trim()
      : 'unscoped'
  return `${base}/form/${encodeURIComponent(fid)}`
}

function optionalAuthHeaders() {
  const name = import.meta.env.VITE_N8N_WEBHOOK_HEADER_NAME
  const value = import.meta.env.VITE_N8N_WEBHOOK_HEADER_VALUE
  if (name && value) return { [String(name)]: String(value) }
  return {}
}

async function postJson(url, body) {
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
    throw new Error(`${url} → ${res.status}: ${text.slice(0, 500)}`)
  }
  return { status: res.status, text }
}

/**
 * @param {'draft' | 'submit'} kind
 * @param {Record<string, unknown>} body JSON-serializable (includes formId from buildN8nBody)
 */
export async function postFormToN8n(kind, body) {
  const webhookUrl = resolveWebhookUrl(kind)
  const formHttpUrl = resolveFormHttpUrl(body)

  if (!webhookUrl && !formHttpUrl) {
    throw new Error(
      'חסרה הגדרת n8n: הגדר VITE_N8N_URL (בסיס ל־POST …/form/:form_id) ו/או VITE_N8N_WEBHOOK_URL ב-Vercel',
    )
  }

  const tasks = []
  if (formHttpUrl) tasks.push(postJson(formHttpUrl, body))
  if (webhookUrl) tasks.push(postJson(webhookUrl, body))

  const results = await Promise.allSettled(tasks)
  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    const msg = failures.map((f) => (f.status === 'rejected' ? f.reason?.message || String(f.reason) : '')).join(' | ')
    throw new Error(msg || 'שגיאת שליחה ל-n8n')
  }

  return { ok: true }
}
