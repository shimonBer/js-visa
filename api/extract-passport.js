/**
 * POST /api/extract-passport
 * Raw image body (same pattern as /api/upload): Content-Type = image/* or application/pdf.
 * Uses OpenAI GPT-4o vision to extract passport fields as JSON.
 */

const MAX_BYTES = 4 * 1024 * 1024 // ~4 MiB — within typical serverless body limits
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
    // Step 1: read raw image bytes from the request body
    const buf = await readBodyBuffer(req)
    if (!buf.length) {
      return jsonResponse(res, 400, { error: 'Empty body' })
    }
    if (buf.length > MAX_BYTES) {
      return jsonResponse(res, 413, { error: `Body too large (max ${MAX_BYTES} bytes)` })
    }

    // Step 2: resolve MIME type from Content-Type header
    const rawCt = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
    const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
    if (!allowed.test(rawCt)) {
      return jsonResponse(res, 400, {
        error: 'Unsupported Content-Type; send image/jpeg, image/png, image/gif, image/webp, or application/pdf',
      })
    }

    const base64 = buf.toString('base64')
    const dataUrl = `data:${rawCt};base64,${base64}`

    // Step 3: call OpenAI Chat Completions (GPT-4o) with vision + JSON output
    const PASSPORT_SYSTEM_PROMPT = `You are an expert Israeli passport document extraction and verification engine.

Follow these four steps in order. Do not skip any step.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — OCR the printed face fields
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Read the human-readable printed fields on the passport face:
  Passport No. / Surname / Given Name(s) / Nationality / Sex /
  Date of Birth / Place of Birth / Date of Issue / Date of Expiry / I.D. No.

OCR accuracy rules:
- Watch for commonly confused characters: 0/O, 1/I/l, 5/S, 8/B, 2/Z.
- Extract names exactly as printed in English (preserve capitalisation).
- Dates: convert to YYYY-MM-DD.
- Israeli ID numbers: digits only — strip hyphens/spaces (e.g. 3-3151008-1 → 331510081).
- Never guess an unclear character. If unreadable, record null.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — Decode the MRZ independently
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Read the two lines of monospace text at the bottom of the passport (ICAO TD3 format).
Decode each field strictly by character position:

Line 1 (44 chars):
  pos  1–2  : document type
  pos  3–5  : issuing country code
  pos  6–44 : names — SURNAME<<GIVEN1<GIVEN2<...
              → split on "<<": left = surname, right = given names ("<" → space, then trim)

Line 2 (44 chars):
  pos  1–9  : passport number (strip trailing "<")
  pos 10    : CHECK DIGIT for passport number
  pos 11–13 : nationality code (e.g. ISR → "Israel")
  pos 14–19 : date of birth YYMMDD
  pos 20    : CHECK DIGIT for date of birth
  pos 21    : sex ("M" or "F"; "<" = unspecified)
  pos 22–27 : expiry date YYMMDD
  pos 28    : CHECK DIGIT for expiry date
  pos 29–42 : optional data = Israeli national ID (strip all "<" and "-"; digits only)
  pos 43    : check digit for optional data
  pos 44    : overall composite check digit

Date decoding: YYMMDD where year 00–30 = 2000–2030, year 31–99 = 1931–1999. Convert to YYYY-MM-DD.
Example: "110101" → 2011-01-11

MRZ check digit validation (ICAO algorithm — weights 7, 3, 1 repeating):
- Compute the expected check digit for passport number, DOB, and expiry.
- If the computed digit matches pos 10 / 20 / 28 respectively: the field passed.
- If it does NOT match: the MRZ read for that field is corrupted.
  → Set that field to null. Add a warning: "<fieldName> MRZ check digit failed — field omitted".
  → Do NOT fall back to the printed face value for that field.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — Compare OCR (Step 1) vs MRZ (Step 2)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For every field that exists in both sources, compare the two values:
- If they AGREE: use the value (high confidence).
- If they DISAGREE: prefer the MRZ value (it is standardised and integrity-checked).
  Add a warning describing the discrepancy, e.g.:
  "Printed DOB 2014-01-11 overridden by MRZ value 2011-01-11"
- Fields only in the printed face (placeOfBirth, dateOfIssue): use OCR value directly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — Build the output JSON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return exactly this JSON object — no markdown, no extra text:
{
  "passportNumber":   <string | null>,   // MRZ line 2 pos 1–9 (check digit must pass)
  "surname":          <string | null>,   // MRZ line 1
  "givenNames":       <string | null>,   // MRZ line 1
  "fullName":         <string | null>,   // givenNames + " " + surname
  "nationality":      <string | null>,   // MRZ line 2 pos 11–13, mapped to English name
  "sex":              <"M"|"F"|null>,    // MRZ line 2 pos 21
  "dateOfBirth":      <string | null>,   // MRZ line 2 pos 14–19 (check digit must pass)
  "placeOfBirth":     <string | null>,   // printed face only
  "dateOfIssue":      <string | null>,   // printed face only
  "dateOfExpiry":     <string | null>,   // MRZ line 2 pos 22–27 (check digit must pass)
  "israeliIdNumber":  <string | null>,   // MRZ line 2 pos 29–42 (digits only)
  "warnings":         <string[]>         // one entry per discrepancy or failed check
}

Rules:
- Accuracy over completeness: return null rather than a guess.
- fullName must equal givenNames + " " + surname (or null if either is null).
- All dates must be valid calendar dates.
- israeliIdNumber must contain digits only.
- warnings must be an array (empty array if no issues).`

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
          max_tokens: 1200,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: PASSPORT_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Extract all passport fields from this image. Return only the JSON object as specified in the system instructions.',
                },
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
      console.error('[extract-passport] OpenAI error', openaiRes.status, rawText.slice(0, 500))
      return jsonResponse(res, 502, {
        error: `OpenAI request failed (${openaiRes.status})`,
        detail: rawText.slice(0, 300),
      })
    }

    // Step 4: parse OpenAI response and the inner JSON payload
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

    const sexRaw = String(extracted.sex ?? '')
      .trim()
      .toUpperCase()
      .slice(0, 1)
    const sex = sexRaw === 'M' || sexRaw === 'F' ? sexRaw : ''

    // Map new rich schema back to the existing API contract,
    // falling back to legacy field names for backward compatibility.
    const out = {
      firstName: String(extracted.givenNames ?? extracted.firstName ?? '').trim(),
      lastName: String(extracted.surname ?? extracted.lastName ?? '').trim(),
      birthDate: String(extracted.dateOfBirth ?? extracted.birthDate ?? '').trim(),
      passportNumber: String(extracted.passportNumber ?? '').trim(),
      issuingCountry: String(extracted.nationality ?? extracted.issuingCountry ?? extracted.country ?? '').trim(),
      sex,
      nationalId: String(extracted.israeliIdNumber ?? extracted.nationalId ?? '').trim(),
      // Extended fields from the new schema
      placeOfBirth: String(extracted.placeOfBirth ?? '').trim() || undefined,
      dateOfIssue: String(extracted.dateOfIssue ?? '').trim() || undefined,
      dateOfExpiry: String(extracted.dateOfExpiry ?? '').trim() || undefined,
      warnings: Array.isArray(extracted.warnings) ? extracted.warnings : [],
    }

    // Strip undefined keys so JSON stays clean
    for (const k of Object.keys(out)) {
      if (out[k] === undefined) delete out[k]
    }

    return jsonResponse(res, 200, out)
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'OpenAI request timed out' : e?.message || 'extract-passport error'
    console.error('[extract-passport]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
