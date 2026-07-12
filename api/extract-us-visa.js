/**
 * POST /api/extract-us-visa
 * Raw image body: Content-Type = image/* or application/pdf.
 * GPT-4o vision → issueDate, expirationDate (YYYY-MM-DD or empty).
 */

const MAX_BYTES = 4 * 1024 * 1024
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_TIMEOUT_MS = 60_000

/** @param {import('http').IncomingMessage} req */
async function readBodyBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function jsonResponse(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function strOrEmpty(v) {
  if (v === null || v === undefined) return ''
  return String(v).trim()
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
    const buf = await readBodyBuffer(req)
    if (!buf.length) {
      return jsonResponse(res, 400, { error: 'Empty body' })
    }
    if (buf.length > MAX_BYTES) {
      return jsonResponse(res, 413, { error: `Body too large (max ${MAX_BYTES} bytes)` })
    }

    const rawCt = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
    const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
    if (!allowed.test(rawCt)) {
      return jsonResponse(res, 400, {
        error: 'Unsupported Content-Type; send image/jpeg, image/png, image/gif, image/webp, or application/pdf',
      })
    }

    const base64 = buf.toString('base64')
    const dataUrl = `data:${rawCt};base64,${base64}`

    const promptText =
      'You are a U.S. visa document extraction assistant.\n\n' +
      'Extract the following fields from the visa:\n\n' +
      '- issue_date\n' +
      '- expiration_date\n' +
      '- visa_number\n\n' +
      'Use the MRZ to validate any fields that are encoded in it (e.g., expiration_date). ' +
      'Verify MRZ check digits when possible. ' +
      'Do not use the MRZ for visa_number or issue_date, as they are not encoded there.\n\n' +
      'Additional rules:\n' +
      '* Normalize dates into YYYY-MM-DD format\n' +
      '* Do NOT guess unclear values\n' +
      '* If a field cannot be confidently extracted or fails validation, return null\n\n' +
      'Return ONLY valid JSON in this exact format (no markdown):\n\n' +
      '{\n' +
      '"issueDate": "",\n' +
      '"expirationDate": "",\n' +
      '"visaNumber": ""\n' +
      '}\n\n' +
      'Use JSON null for any field that is missing or unclear.'

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
          max_tokens: 400,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: promptText }, { type: 'image_url', image_url: { url: dataUrl } }],
            },
          ],
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(t)
    }

    const rawText = await openaiRes.text()
    if (!openaiRes.ok) {
      console.error('[extract-us-visa] OpenAI error', openaiRes.status, rawText.slice(0, 500))
      return jsonResponse(res, 502, {
        error: `OpenAI request failed (${openaiRes.status})`,
        detail: rawText.slice(0, 300),
      })
    }

    let completion
    try {
      completion = JSON.parse(rawText)
    } catch {
      return jsonResponse(res, 502, { error: 'Invalid JSON from OpenAI' })
    }
    const content = completion?.choices?.[0]?.message?.content
    if (!content || typeof content !== 'string') {
      return jsonResponse(res, 502, { error: 'Missing assistant message from OpenAI' })
    }

    let extracted
    try {
      extracted = JSON.parse(content)
    } catch {
      return jsonResponse(res, 502, { error: 'Assistant did not return valid JSON', detail: content.slice(0, 200) })
    }

    const issueDate = strOrEmpty(extracted.issueDate)
    const expirationDate = strOrEmpty(extracted.expirationDate)
    const visaNumber = strOrEmpty(extracted.visaNumber)

    return jsonResponse(res, 200, { issueDate, expirationDate, visaNumber })
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'OpenAI request timed out' : e?.message || 'extract-us-visa error'
    console.error('[extract-us-visa]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
