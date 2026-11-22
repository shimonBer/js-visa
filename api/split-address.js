/**
 * POST /api/split-address
 * Body: { street, city?, state?, zip? }
 * Response: { street, city, state, zip, source: "rules" | "model" }
 *
 * Rules run first. The model is only asked when the street line is still a
 * packed U.S. address longer than the DS-160 box.
 */

import { OPENAI_MODELS } from '../lib/openaiModels.js'
import { splitUsStayAddress, streetStillPacked } from '../lib/usStayAddress.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

const SYSTEM_PROMPT = `Split one pasted U.S. address into DS-160 fields. Reply with JSON only:
{"street":"","city":"","state":"","zip":""}

Rules:
- street is only the street name and building number, at most 40 characters. No city, state, ZIP, or country.
- A building number pasted after the country still belongs on the street. "Flamingo Drive Macon, Georgia 31206 United States 3495" → street "Flamingo Drive 3495", city "Macon", state "GA", zip "31206".
- state is the 2-letter USPS code.
- Keep a city, state, or ZIP already supplied unless the pasted line clearly contains a different one.
- Do not invent a different street. If you cannot separate the line, return the original street unchanged.`

function jsonResponse(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readBodyJson(req) {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

function acceptModelSplit(parsed, fallback) {
  const split = splitUsStayAddress({
    street: parsed?.street || fallback.street,
    city: parsed?.city || fallback.city,
    state: parsed?.state || fallback.state,
    zip: parsed?.zip || fallback.zip,
  })
  if (!split.street || split.street.length > 40 || streetStillPacked(split.street)) return null
  return split
}

async function askModel(raw, fallback, apiKey) {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODELS.translation,
      max_completion_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            street: raw.street,
            city: raw.city || '',
            state: raw.state || '',
            zip: raw.zip || '',
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) return null
  const payload = await response.json()
  const content = payload?.choices?.[0]?.message?.content?.trim()
  if (!content) return null
  try {
    return acceptModelSplit(JSON.parse(content), fallback)
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return jsonResponse(res, 405, { error: 'Method not allowed' })
  }

  let body
  try {
    body = await readBodyJson(req)
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' })
  }

  const raw = {
    street: String(body?.street ?? '').trim(),
    city: String(body?.city ?? '').trim(),
    state: String(body?.state ?? '').trim(),
    zip: String(body?.zip ?? '').trim(),
  }
  if (!raw.street) return jsonResponse(res, 400, { error: 'Missing street' })

  const local = splitUsStayAddress(raw)
  if (!streetStillPacked(local.street)) {
    return jsonResponse(res, 200, { ...local, source: 'rules' })
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return jsonResponse(res, 200, { ...local, source: 'rules' })

  try {
    const modeled = await askModel(raw, local, apiKey)
    if (!modeled) return jsonResponse(res, 200, { ...local, source: 'rules' })
    return jsonResponse(res, 200, { ...modeled, source: 'model' })
  } catch (err) {
    console.warn('[split-address] model split skipped:', err.message)
    return jsonResponse(res, 200, { ...local, source: 'rules' })
  }
}
