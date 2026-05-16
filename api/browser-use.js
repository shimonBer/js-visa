/**
 * POST /api/browser-use
 * Browser Use Cloud API v3: create session, wait 20s, poll GET /sessions/{id} every 20s until terminal (max 5 min).
 * API key: process.env.BROWSER_USE_API_KEY (header X-Browser-Use-API-Key)
 */

const BASE_URL = 'https://api.browser-use.com/api/v3'
const SESSIONS_URL = `${BASE_URL}/sessions`
/** Wait before first GET /sessions/{id} after POST /sessions (per product spec). */
const POLL_INITIAL_WAIT_MS = 20_000
/** Wait between subsequent polls. */
const POLL_INTERVAL_MS = 20_000
/** Max wall time for polling (5 min at 20s cadence). */
const POLL_TIMEOUT_MS = 300_000

/** Max characters of upstream response body to log (avoid huge logs). */
const MAX_LOG_BODY_CHARS = 15_000

function logBv(message, /** @type {Record<string, unknown>} */ data = {}) {
  console.log('[browser-use]', message, data)
}

/**
 * @param {unknown} body
 */
function summarizeSessionPayload(body) {
  if (!body || typeof body !== 'object') return { type: typeof body }
  const o = /** @type {Record<string, unknown>} */ (body)
  return {
    keys: Object.keys(o),
    id: o.id,
    status: o.status,
    hasOutput: o.output != null,
    outputType: o.output != null ? typeof o.output : 'none',
    error: o.error,
    message: typeof o.message === 'string' ? o.message.slice(0, 500) : o.message,
  }
}

/**
 * Fetch Browser Use API, log HTTP status + raw body (truncated) + parsed summary, return JSON.
 * @param {string} url
 * @param {RequestInit} options
 * @param {string} label
 */
async function fetchJsonLogged(url, options, label) {
  const started = Date.now()
  const res = await fetch(url, options)
  const text = await res.text()
  const elapsedMs = Date.now() - started
  const bodyForLog =
    text.length > MAX_LOG_BODY_CHARS
      ? `${text.slice(0, MAX_LOG_BODY_CHARS)}\n... [truncated ${text.length - MAX_LOG_BODY_CHARS} chars]`
      : text

  let parsed = null
  let parseError = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e)
    }
  }

  logBv(`${label} HTTP response`, {
    url,
    method: options.method || 'GET',
    httpStatus: res.status,
    ok: res.ok,
    elapsedMs,
    bodyLength: text.length,
    parseError,
    bodyText: bodyForLog,
  })

  if (parsed && typeof parsed === 'object') {
    logBv(`${label} parsed summary`, summarizeSessionPayload(parsed))
  }

  if (!res.ok) {
    throw new Error(`${label} failed (${res.status}): ${text.slice(0, 500)}`)
  }
  if (parseError) {
    throw new Error(`${label}: invalid JSON body (${parseError})`)
  }
  return parsed
}

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

/** Terminal session statuses (see OpenAPI BuAgentSessionStatus). */
const TERMINAL_STATUSES = new Set(['stopped', 'timed_out', 'error'])

/**
 * Build natural-language task with injected values.
 * @param {{ firstName: string, lastName: string, birthDate: string, passportNumber: string, country: string }} p
 */
function buildI94Task(p) {
  const { firstName, lastName, birthDate, passportNumber, country } = p

  logBv('buildI94Task input fields', {
    firstName,
    lastName,
    birthDate,
    passportNumber,
    country,
  })

  const successExample = JSON.stringify(
    {
      success: true,
      history: [{ date: '', type: '', location: '' }],
    },
    null,
    2,
  )
  const failExample = JSON.stringify({ success: false, history: [] }, null, 2)

  const task = [
    'You are operating a real web browser.',
    '',
    'IMPORTANT BEHAVIOR RULES:',
    '',
    '* Behave like a normal human user.',
    '* Use realistic timing between actions.',
    '* Do NOT interact too quickly.',
    '* Add small delays between typing and clicks.',
    '* Type naturally into input fields instead of inserting all text instantly.',
    '* Occasionally move the mouse, scroll naturally, and interact with the page in a human-like way.',
    '* The site uses reCAPTCHA and bot detection, so avoid behavior that looks automated.',
    '* Wait for elements to fully render before interacting.',
    '* If a popup, loading state, or dynamic content appears, wait for it properly.',
    '',
    'TASK:',
    '',
    '1. Open:',
    '   https://i94.cbp.dhs.gov/home',
    '',
    '2. Wait for the homepage to fully load.',
    '',
    '3. Click:',
    '   "View Travel History"',
    '',
    '4. Wait for the Terms of Service (or similar consent modal) to appear.',
    '',
    '5. Scroll the modal completely to the bottom.',
    '',
    '6. Click the Agree / Continue / Accept button to proceed.',
    '',
    '7. Fill the form with EXACTLY these values:',
    '',
    '* First name:',
    `  ${firstName}`,
    '',
    '* Last name:',
    `  ${lastName}`,
    '',
    '* Birth date:',
    `  ${birthDate}`,
    '',
    'IMPORTANT:',
    'Use the exact date format expected by the website.',
    'If necessary, convert to MM/DD/YYYY.',
    '',
    '* Passport number:',
    `  ${passportNumber}`,
    '',
    '* Passport country / issuing country:',
    `  ${country}`,
    '',
    '8. Submit the form.',
    '',
    '9. Wait for the results page to fully load.',
    '',
    '10. Extract ALL travel history entries.',
    '',
    'For each row extract:',
    '',
    '* date',
    '* entry/exit type',
    '* airport / border crossing / location',
    '',
    '11. Return ONLY valid raw JSON.',
    '',
    'DO NOT:',
    '',
    '* explain actions',
    '* include markdown',
    '* include commentary',
    '* include code blocks',
    '',
    'Return EXACTLY this structure:',
    '',
    successExample,
    '',
    'If the process fails, no records are found, reCAPTCHA blocks progress, or the data cannot be retrieved, return ONLY:',
    '',
    failExample,
  ].join('\n')

  logBv('buildI94Task task string', {
    taskLengthChars: task.length,
    task,
  })

  return task
}

/**
 * Normalize agent output into { success, history }.
 * @param {unknown} parsed
 * @param {number} [depth]
 */
function normalizeBrowserUseResult(parsed, depth = 0) {
  if (depth === 0) {
    logBv('normalizeBrowserUseResult input', {
      type: typeof parsed,
      keys: parsed && typeof parsed === 'object' ? Object.keys(/** @type {object} */ (parsed)) : null,
    })
  }
  if (parsed && typeof parsed === 'object') {
    const o = /** @type {Record<string, unknown>} */ (parsed)
    if (typeof o.success === 'boolean' && Array.isArray(o.history)) {
      const out = {
        success: o.success,
        history: o.history.map((h) => ({
          date: String((h && h.date) ?? ''),
          type: String((h && h.type) ?? ''),
          location: String((h && h.location) ?? ''),
        })),
      }
      logBv('normalizeBrowserUseResult matched { success, history }', {
        depth,
        success: out.success,
        historyLength: out.history.length,
      })
      return out
    }
    const inner = o.result ?? o.output ?? o.data
    if (typeof inner === 'string') {
      try {
        return normalizeBrowserUseResult(JSON.parse(inner), depth + 1)
      } catch {
        logBv('normalizeBrowserUseResult inner string JSON.parse failed', {
          depth,
          preview: inner.slice(0, 400),
        })
        /* fall through */
      }
    }
    if (inner && typeof inner === 'object') {
      logBv('normalizeBrowserUseResult recurse into inner object', { depth, innerKeys: Object.keys(inner) })
      return normalizeBrowserUseResult(inner, depth + 1)
    }
  }
  logBv('normalizeBrowserUseResult fallback { success: false, history: [] }', { depth })
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
  logBv('pollSessionUntilDone start', {
    sessionId,
    deadlineIso: new Date(deadline).toISOString(),
    POLL_INITIAL_WAIT_MS,
    POLL_INTERVAL_MS,
    POLL_TIMEOUT_MS,
  })

  await sleep(POLL_INITIAL_WAIT_MS)
  logBv('pollSessionUntilDone initial wait complete', { sessionId })

  let pollIndex = 0
  while (Date.now() < deadline) {
    pollIndex += 1
    const pollUrl = `${SESSIONS_URL}/${encodeURIComponent(sessionId)}`
    const session = await fetchJsonLogged(
      pollUrl,
      {
        method: 'GET',
        headers: {
          'X-Browser-Use-API-Key': apiKey,
          Accept: 'application/json',
        },
      },
      `GET /sessions/${sessionId} (poll #${pollIndex})`,
    )
    const status = typeof session?.status === 'string' ? session.status : ''
    logBv(`poll #${pollIndex} decision`, {
      status: status || '(empty)',
      isTerminal: TERMINAL_STATUSES.has(status),
      msRemaining: Math.max(0, deadline - Date.now()),
    })

    if (TERMINAL_STATUSES.has(status)) {
      logBv('pollSessionUntilDone terminal reached', { sessionId, status, pollCount: pollIndex })
      return session
    }

    await sleep(POLL_INTERVAL_MS)
  }

  logBv('pollSessionUntilDone timed out', { sessionId, lastPollIndex: pollIndex })
  throw new Error(`Browser Use session ${sessionId} timed out after ${POLL_TIMEOUT_MS}ms`)
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    logBv('handler rejected non-POST', { method: req.method })
    res.setHeader('Allow', 'POST')
    return jsonResponse(res, 405, { error: 'Method not allowed' })
  }

  const apiKey = process.env.BROWSER_USE_API_KEY?.trim()
  if (!apiKey) {
    logBv('handler BROWSER_USE_API_KEY missing')
    return jsonResponse(res, 503, { error: 'Browser Use not configured', code: 'BROWSER_USE_DISABLED' })
  }

  try {
    logBv('handler POST /api/browser-use invoked', { hasApiKey: Boolean(apiKey) })

    const body = await readBodyJson(req)
    const firstName = String(body?.firstName ?? '').trim()
    const lastName = String(body?.lastName ?? '').trim()
    const birthDate = String(body?.birthDate ?? '').trim()
    const passportNumber = String(body?.passportNumber ?? '').trim()
    const country = String(body?.country ?? '').trim()

    if (!firstName || !lastName || !birthDate || !passportNumber || !country) {
      logBv('handler validation failed: missing I-94 fields', {
        hasFirstName: Boolean(firstName),
        hasLastName: Boolean(lastName),
        hasBirthDate: Boolean(birthDate),
        hasPassportNumber: Boolean(passportNumber),
        hasCountry: Boolean(country),
      })
      return jsonResponse(res, 400, {
        error: 'Missing required fields: firstName, lastName, birthDate, passportNumber, country',
      })
    }

    logBv('handler validated traveller fields', { firstName, lastName, birthDate, passportNumber, country })

    const task = buildI94Task({ firstName, lastName, birthDate, passportNumber, country })

    // Step 1: create a Browser Use v3 session with the I-94 task
    const created = await fetchJsonLogged(
      SESSIONS_URL,
      {
        method: 'POST',
        headers: {
          'X-Browser-Use-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ task }),
      },
      'POST /sessions (create)',
    )
    const sessionId = created?.id
    if (!sessionId || typeof sessionId !== 'string') {
      logBv('create session response missing id', summarizeSessionPayload(created))
      throw new Error('Browser Use create session response missing id')
    }
    logBv('create session ok', { sessionId, initialStatus: created?.status })

    // If the task finished before we start polling (rare), return output immediately
    if (typeof created?.status === 'string' && TERMINAL_STATUSES.has(created.status)) {
      logBv('create response already terminal; skipping poll', {
        status: created.status,
        payload: summarizeSessionPayload(created),
      })
      const normalizedEarly = normalizeBrowserUseResult(created?.output ?? created)
      logBv('handler returning early (terminal on create)', normalizedEarly)
      return jsonResponse(res, 200, normalizedEarly)
    }

    // Step 2: poll session until stopped / timed_out / error
    const finalSession = await pollSessionUntilDone(apiKey, sessionId)
    logBv('poll complete; final session summary', summarizeSessionPayload(finalSession))

    // Step 3: extract structured output from the final session payload
    const output = finalSession?.output
    const normalized = normalizeBrowserUseResult(output ?? finalSession)
    logBv('handler returning normalized I-94 payload', normalized)

    return jsonResponse(res, 200, normalized)
  } catch (e) {
    const msg = e?.message || 'browser-use error'
    console.error('[browser-use] handler error', msg, e instanceof Error ? e.stack : e)
    return jsonResponse(res, 500, { error: msg })
  }
}
