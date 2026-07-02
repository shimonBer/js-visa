/**
 * I-94 travel history lookup via /api/i94-lookup.
 *
 * The server function now has two fast actions so it never breaches Vercel
 * Hobby's 10-second timeout. The client drives the polling loop.
 *
 *   1. POST { action:"create", ...fields }  → { pending:true, sessionId }
 *   2. Loop: POST { action:"poll", sessionId } every POLL_INTERVAL_MS
 *      until { pending:false, success, history[] } or timeout/error
 *
 * @param {{ firstName: string, lastName: string, birthDate: string, passportNumber: string, country: string }} input
 * @param {{ totalTimeoutMs?: number, pollIntervalMs?: number, onStatus?: (msg: string) => void }} [opts]
 * @returns {Promise<{ success: boolean, history: { date: string, type: string, location: string }[] }>}
 */
export async function fetchI94TravelHistory(input, opts = {}) {
  const totalTimeoutMs = opts.totalTimeoutMs ?? 300_000   // 5 min total
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000    // poll every 15s
  const onStatus = opts.onStatus ?? (() => {})

  const deadline = Date.now() + totalTimeoutMs

  // ── Step 1: create session (fast, < 5s) ───────────────────────────────────
  onStatus('יוצר סשן…')
  const createRes = await fetch('/api/i94-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      firstName: input.firstName,
      lastName: input.lastName,
      birthDate: input.birthDate,
      passportNumber: input.passportNumber,
      country: input.country,
    }),
  })

  const createJson = await parseResponse(createRes, 'create')

  // Already done (rare)
  if (createJson.pending === false) {
    return normalizeResult(createJson)
  }

  const sessionId = createJson.sessionId
  if (!sessionId) throw new Error('No sessionId returned from create')

  // ── Step 2: client-side polling loop ──────────────────────────────────────
  let pollCount = 0
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    pollCount++
    onStatus(`בודק סטטוס… (${pollCount})`)

    const pollRes = await fetch('/api/i94-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Resend traveler data as fallback if /tmp file is gone on the server
      body: JSON.stringify({
        action: 'poll',
        sessionId,
        firstName:      input.firstName,
        lastName:       input.lastName,
        birthDate:      input.birthDate,
        passportNumber: input.passportNumber,
        country:        input.country,
      }),
    })

    const pollJson = await parseResponse(pollRes, `poll #${pollCount}`)

    if (pollJson.pending === false) {
      onStatus('הושלם')
      return normalizeResult(pollJson)
    }
    // still running — loop
  }

  throw new Error(`I-94 lookup timed out after ${Math.round(totalTimeoutMs / 60000)} min`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function parseResponse(res, label) {
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch {
    throw new Error(`${label}: invalid JSON (${text.slice(0, 200)})`)
  }
  if (!res.ok) throw new Error(json?.error || json?.detail || `${label} failed (${res.status})`)
  return json
}

function normalizeResult(json) {
  return {
    success: Boolean(json.success),
    history: Array.isArray(json.history)
      ? json.history.map((h) => ({
          date: String(h?.date ?? ''),
          type: String(h?.type ?? ''),
          location: String(h?.location ?? ''),
        }))
      : [],
  }
}
