/**
 * I-94 travel history lookup.
 *
 * If VITE_I94_SERVICE_URL is set (e.g. https://i94.up.railway.app), calls
 * that Railway service directly — a single POST that waits up to 120 seconds.
 * This bypasses Vercel's 10-second serverless timeout entirely.
 *
 * If VITE_I94_SERVICE_URL is not set, falls back to the create/poll pattern
 * via /api/i94-lookup (local vercel dev only).
 *
 * @param {{ firstName, lastName, birthDate, passportNumber, country }} input
 * @param {{ onStatus?: (msg: string) => void }} [opts]
 * @returns {Promise<{ success: boolean, history: { date, type, location }[] }>}
 */
export async function fetchI94TravelHistory(input, opts = {}) {
  const onStatus = opts.onStatus ?? (() => {})
  const railwayUrl = import.meta.env?.VITE_I94_SERVICE_URL
  const secret     = import.meta.env?.VITE_I94_SECRET ?? ''

  if (railwayUrl) {
    return fetchDirect(railwayUrl, secret, input, onStatus)
  }
  return fetchViaPolling(input, opts)
}

// ─── Direct Railway call (single request, long timeout) ─────────────────────

async function fetchDirect(serviceUrl, secret, input, onStatus) {
  onStatus('מתחבר לשירות…')

  const base = serviceUrl.replace(/\/$/, '')
  const headers = { 'Content-Type': 'application/json' }
  if (secret) headers['Authorization'] = `Bearer ${secret}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)  // 2 min client timeout

  try {
    onStatus('מחפש היסטוריית כניסות…')
    const res = await fetch(`${base}/lookup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        firstName:      input.firstName,
        lastName:       input.lastName,
        birthDate:      input.birthDate,
        passportNumber: input.passportNumber,
        country:        input.country,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)
    const text = await res.text()
    let json
    try { json = text ? JSON.parse(text) : {} } catch {
      throw new Error(`שגיאה בתגובה: ${text.slice(0, 200)}`)
    }
    if (!res.ok) throw new Error(json?.error ?? `שגיאה ${res.status}`)
    onStatus('הושלם')
    return normalizeResult(json)
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') throw new Error('הזמן פג — הבדיקה לקחה יותר מ-2 דקות')
    throw e
  }
}

// ─── Local polling fallback (vercel dev) ─────────────────────────────────────

async function fetchViaPolling(input, opts = {}) {
  const totalTimeoutMs = opts.totalTimeoutMs ?? 300_000
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000
  const onStatus = opts.onStatus ?? (() => {})
  const deadline = Date.now() + totalTimeoutMs

  onStatus('יוצר סשן…')
  const createRes = await fetch('/api/i94-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', ...input }),
  })
  const createJson = await parseResponse(createRes, 'create')
  if (createJson.pending === false) return normalizeResult(createJson)

  const sessionId = createJson.sessionId
  if (!sessionId) throw new Error('No sessionId returned from create')

  let pollCount = 0
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    pollCount++
    onStatus(`בודק סטטוס… (${pollCount})`)

    const pollRes = await fetch('/api/i94-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'poll', sessionId, ...input }),
    })
    const pollJson = await parseResponse(pollRes, `poll #${pollCount}`)
    if (pollJson.pending === false) {
      onStatus('הושלם')
      return normalizeResult(pollJson)
    }
  }

  throw new Error(`I-94 lookup timed out after ${Math.round(totalTimeoutMs / 60000)} min`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function parseResponse(res, label) {
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch {
    throw new Error(`${label}: invalid JSON (${text.slice(0, 200)})`)
  }
  if (!res.ok) throw new Error(json?.error || `${label} failed (${res.status})`)
  return json
}

function normalizeResult(json) {
  return {
    success: Boolean(json.success),
    history: Array.isArray(json.history)
      ? json.history.map(h => ({
          date:     String(h?.date ?? ''),
          type:     String(h?.type ?? ''),
          location: String(h?.location ?? ''),
        }))
      : [],
  }
}
