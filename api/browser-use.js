/**
 * POST /api/browser-use
 * Browser Use Cloud API v3: create session, poll until terminal state, return I-94 travel history JSON.
 * API key: process.env.BROWSER_USE_API_KEY (header X-Browser-Use-API-Key)
 */

const BASE_URL = 'https://api.browser-use.com/api/v3'
const SESSIONS_URL = `${BASE_URL}/sessions`
const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 120_000

/** @param {import('http').IncomingMessage} req */
async function readBodyJson(req) {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body
  }
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Invalid JSON body')
  }
}

function jsonResponse(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {Response} res
 * @param {string} context
 */
async function parseJsonOrThrow(res, context) {
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${context} failed (${res.status}): ${text.slice(0, 500)}`)
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${context}: invalid JSON body`)
  }
}

/** Terminal session statuses (see OpenAPI BuAgentSessionStatus). */
const TERMINAL_STATUSES = new Set(['stopped', 'timed_out', 'error'])

/**
 * Build natural-language task with injected values.
 * @param {{ firstName: string, lastName: string, birthDate: string, passportNumber: string, country: string }} p
 */
function buildI94Task(p) {
  const { firstName, lastName, birthDate, passportNumber, country } = p
  return [
    'You are automating a web browser.',
    '1) Open https://i94.cbp.dhs.gov/search/history-search',
    '2) Click the control or link labeled "Travel History" (or equivalent to start travel history retrieval).',
    '3) Wait until a Terms of Service or similar modal appears.',
    '4) Scroll that modal all the way to the bottom.',
    '5) Click the Agree / Continue / Accept button to dismiss the modal.',
    '6) Fill the form with EXACTLY these values:',
    `   - First name: ${firstName}`,
    `   - Last name: ${lastName}`,
    `   - Birth date: ${birthDate} (use the format the site expects, e.g. MM/DD/YYYY if required)`,
    `   - Passport number: ${passportNumber}`,
    `   - Passport country / issuing country: ${country}`,
    '7) Submit the form.',
    '8) After results load, extract ALL travel history rows (date, entry/exit or type, port/location).',
    '9) Return ONLY valid JSON (no markdown, no explanations) with this exact shape:',
    '{"success": true, "history": [{"date": "", "type": "", "location": ""}]}',
    'If the flow fails or data is unavailable, return {"success": false, "history": []} only.',
  ].join('\n')
}

/**
 * Normalize agent output into { success, history }.
 * @param {unknown} parsed
 */
function normalizeBrowserUseResult(parsed) {
  if (parsed && typeof parsed === 'object') {
    const o = /** @type {Record<string, unknown>} */ (parsed)
    if (typeof o.success === 'boolean' && Array.isArray(o.history)) {
      return {
        success: o.success,
        history: o.history.map((h) => ({
          date: String((h && h.date) ?? ''),
          type: String((h && h.type) ?? ''),
          location: String((h && h.location) ?? ''),
        })),
      }
    }
    const inner = o.result ?? o.output ?? o.data
    if (typeof inner === 'string') {
      try {
        return normalizeBrowserUseResult(JSON.parse(inner))
      } catch {
        /* fall through */
      }
    }
    if (inner && typeof inner === 'object') {
      return normalizeBrowserUseResult(inner)
    }
  }
  return { success: false, history: [] }
}

/**
 * Poll GET /sessions/{id} until status is terminal or timeout.
 * @param {string} apiKey
 * @param {string} sessionId
 * @returns {Promise<unknown>} final session JSON (includes output)
 */
async function pollSessionUntilDone(apiKey, sessionId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    // Wait 2 seconds between polls (per product requirement)
    await sleep(POLL_INTERVAL_MS)

    const pollRes = await fetch(`${SESSIONS_URL}/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: {
        'X-Browser-Use-API-Key': apiKey,
        Accept: 'application/json',
      },
    })

    const session = await parseJsonOrThrow(pollRes, `GET /sessions/${sessionId}`)
    const status = typeof session?.status === 'string' ? session.status : ''

    if (TERMINAL_STATUSES.has(status)) {
      return session
    }
  }

  throw new Error(`Browser Use session ${sessionId} timed out after ${POLL_TIMEOUT_MS}ms`)
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return jsonResponse(res, 405, { error: 'Method not allowed' })
  }

  const apiKey = process.env.BROWSER_USE_API_KEY?.trim()
  if (!apiKey) {
    return jsonResponse(res, 503, { error: 'Browser Use not configured', code: 'BROWSER_USE_DISABLED' })
  }

  try {
    const body = await readBodyJson(req)
    const firstName = String(body?.firstName ?? '').trim()
    const lastName = String(body?.lastName ?? '').trim()
    const birthDate = String(body?.birthDate ?? '').trim()
    const passportNumber = String(body?.passportNumber ?? '').trim()
    const country = String(body?.country ?? '').trim()

    if (!firstName || !lastName || !birthDate || !passportNumber || !country) {
      return jsonResponse(res, 400, {
        error: 'Missing required fields: firstName, lastName, birthDate, passportNumber, country',
      })
    }

    const task = buildI94Task({ firstName, lastName, birthDate, passportNumber, country })

    // Step 1: create a Browser Use v3 session with the I-94 task
    const createRes = await fetch(SESSIONS_URL, {
      method: 'POST',
      headers: {
        'X-Browser-Use-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ task }),
    })

    const created = await parseJsonOrThrow(createRes, 'POST /sessions')
    const sessionId = created?.id
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Browser Use create session response missing id')
    }

    // If the task finished before we start polling (rare), return output immediately
    if (typeof created?.status === 'string' && TERMINAL_STATUSES.has(created.status)) {
      const normalizedEarly = normalizeBrowserUseResult(created?.output ?? created)
      return jsonResponse(res, 200, normalizedEarly)
    }

    // Step 2: poll session until stopped / timed_out / error
    const finalSession = await pollSessionUntilDone(apiKey, sessionId)

    // Step 3: extract structured output from the final session payload
    const output = finalSession?.output
    const normalized = normalizeBrowserUseResult(output ?? finalSession)

    return jsonResponse(res, 200, normalized)
  } catch (e) {
    const msg = e?.message || 'browser-use error'
    console.error('[browser-use]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
