/**
 * POST /api/browser-use
 * Proxies to Browser Use Cloud: runs an I-94 travel history lookup with injected traveller data.
 * API key: process.env.BROWSER_USE_API_KEY
 */

const BROWSER_USE_URL = 'https://api.browser-use.com/api/v1/run-task'
const UPSTREAM_TIMEOUT_MS = 90_000

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
  return JSON.parse(raw)
}

function jsonResponse(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * Build natural-language task with injected values (no string interpolation in client bundle for secrets).
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
    '9) Return ONLY valid JSON (no markdown) with this exact shape:',
    '{"success": true, "history": [{"date": "string", "type": "string", "location": "string"}]}',
    'If the flow fails or data is unavailable, return {"success": false, "history": []} and optionally add "error": "short reason" in the same JSON object.',
  ].join('\n')
}

/**
 * Normalize Browser Use API response into { success, history }.
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
    // Nested common patterns
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

    // Step: POST to Browser Use Cloud with Bearer auth and JSON body
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    let buRes
    try {
      buRes = await fetch(BROWSER_USE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          task,
          output_format: 'json',
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(t)
    }

    const text = await buRes.text()
    if (!buRes.ok) {
      console.error('[browser-use] upstream error', buRes.status, text.slice(0, 500))
      return jsonResponse(res, buRes.status >= 400 && buRes.status < 600 ? buRes.status : 502, {
        error: `Browser Use API error (${buRes.status})`,
        detail: text.slice(0, 400),
      })
    }

    let parsed
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      return jsonResponse(res, 502, { error: 'Browser Use returned non-JSON', detail: text.slice(0, 200) })
    }

    const normalized = normalizeBrowserUseResult(parsed)
    return jsonResponse(res, 200, normalized)
  } catch (e) {
    const msg =
      e?.name === 'AbortError'
        ? `Browser Use request timed out after ${UPSTREAM_TIMEOUT_MS}ms`
        : e?.message || 'browser-use error'
    console.error('[browser-use]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
