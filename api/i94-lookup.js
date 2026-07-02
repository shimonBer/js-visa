/**
 * POST /api/i94-lookup — I-94 travel history via 2captcha + direct CBP API
 *
 * No browser required. Works on Vercel serverless.
 * Requires TWOCAPTCHA_API_KEY in environment.
 *
 * Two fast actions (each < 5s, safe for Vercel Hobby's 10s timeout):
 *
 * action = "create"
 *   Body: { action, firstName, lastName, birthDate, passportNumber, country }
 *   → Submits a reCAPTCHA v3 task to 2captcha, returns { pending:true, sessionId }
 *
 * action = "poll"
 *   Body: { action, sessionId, firstName, lastName, birthDate, passportNumber, country }
 *   → Checks 2captcha result; if ready, calls CBP API and returns travel history
 *   → Returns { pending:true } if still solving, { pending:false, success, history[] } when done
 */

import { writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ─── CBP API constants (reverse-engineered from i94.cbp.dhs.gov bundle) ──────
const CBP_BASE            = 'https://i94.cbp.dhs.gov'
const CBP_HISTORY_PATH    = '/api/services/travel/history'
const RECAPTCHA_SITE_KEY  = '6Lf3UhUpAAAAAO0Gb6PjXGxtK4yrik2opRKITCMg'
const RECAPTCHA_ACTION    = 'ChkTrvHist'

// ─── 2captcha API ─────────────────────────────────────────────────────────────
const TC_BASE = 'https://api.2captcha.com'

// ─── Country name → ISO 3166-1 alpha-3 ────────────────────────────────────────
const COUNTRY_ALPHA3 = {
  'israel': 'ISR', 'usa': 'USA', 'united states': 'USA', 'us': 'USA',
  'france': 'FRA', 'germany': 'DEU', 'united kingdom': 'GBR', 'uk': 'GBR',
  'canada': 'CAN', 'australia': 'AUS', 'india': 'IND', 'china': 'CHN',
  'japan': 'JPN', 'brazil': 'BRA', 'mexico': 'MEX', 'russia': 'RUS',
  'south korea': 'KOR', 'korea': 'KOR', 'italy': 'ITA', 'spain': 'ESP',
  'netherlands': 'NLD', 'turkey': 'TUR', 'sweden': 'SWE', 'norway': 'NOR',
  'denmark': 'DNK', 'finland': 'FIN', 'poland': 'POL', 'argentina': 'ARG',
  'colombia': 'COL', 'philippines': 'PHL', 'thailand': 'THA',
}

function toAlpha3(country) {
  const lower = (country ?? '').toLowerCase().trim()
  if (COUNTRY_ALPHA3[lower]) return COUNTRY_ALPHA3[lower]
  // Already a 3-letter code
  if (/^[A-Z]{3}$/.test(country)) return country
  return country.toUpperCase().slice(0, 3)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readBodyJson(req) {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new Error('Invalid JSON body') }
}

function reqFile(sessionId) {
  return join(tmpdir(), `i94-req-${sessionId}.json`)
}

// ─── 2captcha ─────────────────────────────────────────────────────────────────

async function createCaptchaTask(apiKey) {
  const res = await fetch(`${TC_BASE}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'RecaptchaV3TaskProxyless',
        websiteURL: `${CBP_BASE}/search/history-search`,
        websiteKey: RECAPTCHA_SITE_KEY,
        minScore: 0.3,
        pageAction: RECAPTCHA_ACTION,
        // Do NOT set isEnterprise:true — causes indefinite processing queue
      },
    }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch {
    throw new Error(`2captcha createTask returned non-JSON: ${text.slice(0, 200)}`)
  }
  console.log('[i94] 2captcha createTask response', json)
  if (json.errorId !== 0) throw new Error(`2captcha createTask error: ${json.errorCode} — ${json.errorDescription}`)
  return String(json.taskId)
}

async function getCaptchaResult(apiKey, taskId) {
  const res = await fetch(`${TC_BASE}/getTaskResult`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, taskId: Number(taskId) }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch {
    throw new Error(`2captcha getTaskResult returned non-JSON: ${text.slice(0, 200)}`)
  }
  if (json.errorId !== 0) throw new Error(`2captcha getTaskResult error: ${json.errorCode}`)
  return json  // { status: 'processing'|'ready', solution: { gRecaptchaResponse } }
}

// ─── CBP API ──────────────────────────────────────────────────────────────────

async function fetchTravelHistory(token, { firstName, lastName, birthDate, passportNumber, country }) {
  const alpha3 = toAlpha3(country)

  // birthDate: accept YYYY-MM-DD or MM/DD/YYYY, normalize to YYYY-MM-DD
  let dob = birthDate
  const mdyMatch = birthDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mdyMatch) dob = `${mdyMatch[3]}-${mdyMatch[1].padStart(2,'0')}-${mdyMatch[2].padStart(2,'0')}`

  // Body format reverse-engineered from real browser network capture
  const body = JSON.stringify({
    firstName: firstName.trim().toUpperCase(),
    lastName:  lastName.trim().toUpperCase(),
    dob,
    document: {
      number:            passportNumber.trim(),
      alpha3CountryCode: alpha3,
    },
  })

  console.log('[i94] calling CBP API', { dob, alpha3, body })

  const res = await fetch(`${CBP_BASE}${CBP_HISTORY_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type':        'application/json',
      'Accept':              'application/json, text/plain, */*',
      'Accept-Language':     'en-US,en;q=0.9',
      'Span-Id':             randomUUID(),
      'span-id-referrer':    '',
      'ReCaptcha-Token':     token,
      'ReCaptcha-Strategy':  'score',
      'i94-action':          RECAPTCHA_ACTION,
      'Origin':              CBP_BASE,
      'Referer':             `${CBP_BASE}/search/history-search`,
      // Spoof real (non-headless) Chrome to avoid bot detection
      'User-Agent':          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'sec-ch-ua':           '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile':    '?0',
      'sec-ch-ua-platform':  '"macOS"',
      'sec-fetch-dest':      'empty',
      'sec-fetch-mode':      'cors',
      'sec-fetch-site':      'same-origin',
    },
    body,
  })

  const text = await res.text()
  console.log('[i94] CBP API response', res.status, text.slice(0, 500))

  if (!res.ok) {
    throw new Error(`CBP API ${res.status}: ${text.slice(0, 300)}`)
  }

  let data
  try { data = JSON.parse(text) } catch { throw new Error(`CBP API returned non-JSON: ${text.slice(0, 200)}`) }

  return parseCbpResponse(data)
}

/**
 * Parse the CBP travel history response into our standard format.
 * Logs the raw structure so we can refine after first real call.
 */
function parseCbpResponse(data) {
  console.log('[i94] CBP raw response keys', Object.keys(data ?? {}))

  // Try common response shapes
  const rows =
    data?.travelHistory ??
    data?.history ??
    data?.records ??
    data?.data ??
    (Array.isArray(data) ? data : null) ??
    []

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('[i94] No travel history rows found in response', JSON.stringify(data).slice(0, 500))
    return { success: false, history: [] }
  }

  const history = rows.map((row) => {
    // Log first row to understand fields
    if (rows.indexOf(row) === 0) console.log('[i94] first row sample', JSON.stringify(row))

    return {
      date:     String(row.date ?? row.arrivalDate ?? row.eventDate ?? row.admitDate ?? '').trim(),
      type:     String(row.type ?? row.i94Class ?? row.eventType ?? row.admitClass ?? row.status ?? '').trim(),
      location: String(row.location ?? row.portCode ?? row.port ?? row.portOfEntry ?? row.city ?? '').trim(),
    }
  }).filter(r => r.date)

  return { success: history.length > 0, history }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return jsonResponse(res, 405, { error: 'Method not allowed' })
  }

  if (process.env.VITE_I94_ENABLED === 'false') {
    return jsonResponse(res, 503, { error: 'I-94 lookup is disabled', code: 'I94_DISABLED' })
  }

  const apiKey = process.env.TWOCAPTCHA_API_KEY?.trim()
  if (!apiKey) {
    return jsonResponse(res, 503, { error: 'TWOCAPTCHA_API_KEY not configured', code: 'CAPTCHA_KEY_MISSING' })
  }

  let body
  try { body = await readBodyJson(req) } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON body' })
  }

  const action = String(body?.action ?? 'create')

  // ── action = "create" ──────────────────────────────────────────────────────
  if (action === 'create') {
    const firstName      = String(body?.firstName      ?? '').trim()
    const lastName       = String(body?.lastName       ?? '').trim()
    const birthDate      = String(body?.birthDate      ?? '').trim()
    const passportNumber = String(body?.passportNumber ?? '').trim()
    const country        = String(body?.country        ?? '').trim()

    if (!firstName || !lastName || !birthDate || !passportNumber || !country) {
      return jsonResponse(res, 400, { error: 'Missing required fields: firstName, lastName, birthDate, passportNumber, country' })
    }

    try {
      const taskId = await createCaptchaTask(apiKey)
      console.log('[i94] 2captcha task created', { taskId, firstName, lastName, birthDate, passportNumber, country })

      // Persist request data so poll can use it
      writeFileSync(reqFile(taskId), JSON.stringify({ firstName, lastName, birthDate, passportNumber, country }))

      return jsonResponse(res, 200, { pending: true, sessionId: taskId })
    } catch (e) {
      console.error('[i94] create error', e?.message)
      return jsonResponse(res, 500, { error: e?.message ?? 'Failed to create captcha task' })
    }
  }

  // ── action = "poll" ────────────────────────────────────────────────────────
  if (action === 'poll') {
    const sessionId = String(body?.sessionId ?? '').trim()
    if (!sessionId) return jsonResponse(res, 400, { error: 'Missing sessionId' })

    try {
      const result = await getCaptchaResult(apiKey, sessionId)

      if (result.status === 'processing') {
        return jsonResponse(res, 200, { pending: true, sessionId })
      }

      const token = result?.solution?.gRecaptchaResponse
      if (!token) throw new Error('2captcha returned no token')

      console.log('[i94] reCAPTCHA token received, calling CBP API')

      // Load persisted request data
      let reqData
      try {
        reqData = JSON.parse(readFileSync(reqFile(sessionId), 'utf8'))
      } catch {
        // Fallback: accept data from body directly (client can resend)
        reqData = {
          firstName:      String(body?.firstName      ?? '').trim(),
          lastName:       String(body?.lastName       ?? '').trim(),
          birthDate:      String(body?.birthDate      ?? '').trim(),
          passportNumber: String(body?.passportNumber ?? '').trim(),
          country:        String(body?.country        ?? '').trim(),
        }
      }

      const history = await fetchTravelHistory(token, reqData)
      return jsonResponse(res, 200, { pending: false, ...history })
    } catch (e) {
      console.error('[i94] poll error', e?.message)
      return jsonResponse(res, 500, { error: e?.message ?? 'Poll failed' })
    }
  }

  return jsonResponse(res, 400, { error: `Unknown action: "${action}"` })
}
