/**
 * POST /api/translate-form
 * Body: JSON { data: object, attachments?: [{ field, fileName, mimeType, base64 }] }
 * Translates DS-160 form + document images to English via GPT-4o.
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_TIMEOUT_MS = 120_000
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024

const TRANSLATION_PROMPT =
  'Translate PDF to English in the order of the order of the ds160 from, extract info from passport and other attachments, dont forget any detail, any missing details mark in red. The address should be in the following format: Street, City, Country. If you have an institution where an address is missing, search the web for the address and complete it yourself according to the provided format. native name extracted from the passport answers in the same line of questions'

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
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return jsonResponse(res, 405, { error: 'Method not allowed' })
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return jsonResponse(res, 503, { error: 'OpenAI not configured', code: 'OPENAI_DISABLED' })
  }

  try {
    const body = await readBodyJson(req)
    const data = body?.data
    if (!data || typeof data !== 'object') {
      return jsonResponse(res, 400, { error: 'Missing data object' })
    }

    const attachments = Array.isArray(body.attachments) ? body.attachments : []
    const content = [
      {
        type: 'text',
        text:
          TRANSLATION_PROMPT +
          '\n\n--- Form fields (JSON) ---\n' +
          JSON.stringify(data, null, 2) +
          (body.fileMeta && typeof body.fileMeta === 'object'
            ? '\n\n--- File metadata (names only) ---\n' + JSON.stringify(body.fileMeta, null, 2)
            : ''),
      },
    ]

    for (const att of attachments) {
      const mime = String(att?.mimeType || 'application/octet-stream').split(';')[0].trim()
      const b64 = String(att?.base64 || '').replace(/\s/g, '')
      if (!b64) continue
      const approxBytes = Math.floor((b64.length * 3) / 4)
      if (approxBytes > MAX_ATTACHMENT_BYTES) {
        return jsonResponse(res, 413, {
          error: `Attachment too large: ${att?.field || 'unknown'} (max ${MAX_ATTACHMENT_BYTES} bytes)`,
        })
      }
      const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
      if (!allowed.test(mime)) {
        return jsonResponse(res, 400, { error: `Unsupported attachment MIME: ${mime}` })
      }
      content.push({
        type: 'text',
        text: `\n[Attachment: ${String(att?.field || 'file')} — ${String(att?.fileName || 'upload')}]`,
      })
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` },
      })
    }

    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
    let openaiRes
    try {
      openaiRes = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 8192,
          messages: [{ role: 'user', content }],
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(t)
    }

    const rawText = await openaiRes.text()
    if (!openaiRes.ok) {
      console.error('[translate-form] OpenAI error', openaiRes.status, rawText.slice(0, 500))
      return jsonResponse(res, 502, {
        error: `OpenAI request failed (${openaiRes.status})`,
        detail: rawText.slice(0, 400),
      })
    }

    let completion
    try {
      completion = JSON.parse(rawText)
    } catch {
      return jsonResponse(res, 502, { error: 'Invalid JSON from OpenAI' })
    }
    const translated = completion?.choices?.[0]?.message?.content
    if (!translated || typeof translated !== 'string') {
      return jsonResponse(res, 502, { error: 'Missing translation text from OpenAI' })
    }

    return jsonResponse(res, 200, { translated })
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'OpenAI request timed out' : e?.message || 'translate-form error'
    console.error('[translate-form]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
