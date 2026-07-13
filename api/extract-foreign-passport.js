/**
 * POST /api/extract-foreign-passport
 * Raw image body; Content-Type = image/* or application/pdf.
 * Returns the passport number extracted from a foreign passport by cross-checking
 * the visual "Passport No." field against the MRZ.
 */

const MAX_BYTES = 4 * 1024 * 1024
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_TIMEOUT_MS = 60_000

/** @param {import('http').IncomingMessage} req */
async function readBodyBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function jsonResponse(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

const SYSTEM_PROMPT = `You are an expert passport OCR engine.

Your task: extract the passport number from the document image.

STEP 1 — VISUAL READ
Find the field visually labeled "Passport No.", "Passport Number", "No. de passeport", "Numéro de passeport", "Reisepass-Nr.", or any equivalent label in any language. Read the value exactly as printed.

STEP 2 — MRZ READ
Locate the Machine Readable Zone (MRZ) — the two lines of monospace text at the bottom of the passport.
According to ICAO 9303 TD3, Line 2 positions 1–9 contain the passport number (strip trailing "<" filler characters).
Read this value exactly as printed. Do NOT guess or correct characters.

STEP 3 — CROSS-CHECK
Compare the visual value (Step 1) with the MRZ value (Step 2).
- If they match: return that value as passportNumber, set matched = true.
- If they differ: return null as passportNumber, set matched = false, and include both raw values in mismatchDetails.
- If only one source is visible: return that value, set matched = false.

RULES
- Never guess unreadable characters. If a character is ambiguous, return null.
- Watch for: 0 ↔ O, 1 ↔ I ↔ l, 2 ↔ Z, 5 ↔ S, 8 ↔ B.
- Strip trailing "<" from MRZ values only.
- Return the passport number exactly as printed (no spaces, no hyphens unless printed).`

const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'foreign_passport_number',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        passportNumber: { type: ['string', 'null'] },
        matched: { type: 'boolean' },
        visualValue: { type: ['string', 'null'] },
        mrzValue: { type: ['string', 'null'] },
        mismatchDetails: { type: ['string', 'null'] },
      },
      required: ['passportNumber', 'matched', 'visualValue', 'mrzValue', 'mismatchDetails'],
      additionalProperties: false,
    },
  },
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
    if (!buf.length) return jsonResponse(res, 400, { error: 'Empty body' })
    if (buf.length > MAX_BYTES) return jsonResponse(res, 413, { error: `Body too large (max ${MAX_BYTES} bytes)` })

    const rawCt = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
    const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
    if (!allowed.test(rawCt)) {
      return jsonResponse(res, 400, { error: 'Unsupported Content-Type; send image/jpeg, image/png, image/gif, image/webp, or application/pdf' })
    }

    const base64 = buf.toString('base64')
    const dataUrl = `data:${rawCt};base64,${base64}`

    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
    let openaiRes
    try {
      openaiRes = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1',
          max_tokens: 500,
          response_format: RESPONSE_SCHEMA,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Read the passport image and identify the passport number using both the visual field labeled "Passport No." and the MRZ. Cross-check both sources. If they match, return only the passport number.' },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
              ],
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
      console.error('[extract-foreign-passport] OpenAI error', openaiRes.status, rawText.slice(0, 500))
      return jsonResponse(res, 502, { error: `OpenAI request failed (${openaiRes.status})`, detail: rawText.slice(0, 300) })
    }

    let completion
    try { completion = JSON.parse(rawText) } catch {
      return jsonResponse(res, 502, { error: 'Invalid JSON from OpenAI' })
    }

    const content = completion?.choices?.[0]?.message?.content
    if (!content || typeof content !== 'string') {
      return jsonResponse(res, 502, { error: 'Missing assistant message from OpenAI' })
    }

    let extracted
    try { extracted = JSON.parse(content) } catch {
      return jsonResponse(res, 502, { error: 'Assistant did not return valid JSON', detail: content.slice(0, 200) })
    }

    return jsonResponse(res, 200, {
      passportNumber: extracted.passportNumber ?? null,
      matched: extracted.matched ?? false,
      visualValue: extracted.visualValue ?? null,
      mrzValue: extracted.mrzValue ?? null,
      mismatchDetails: extracted.mismatchDetails ?? null,
    })
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'OpenAI request timed out' : e?.message || 'extract-foreign-passport error'
    console.error('[extract-foreign-passport]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
