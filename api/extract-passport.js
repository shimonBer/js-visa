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

Analyze the uploaded Israeli passport image and extract all visible passport information with maximum accuracy.

Accuracy Requirements
- Perform TWO independent extraction passes on the document.
- Compare the results from both passes.
- If the two passes disagree on any character, number, or date:
  - Mark the field as potentially uncertain.
  - Add a warning describing the discrepancy.
- Never guess missing or unclear characters. If a value cannot be read with high confidence, return null.
- Accuracy is more important than completeness.
- Use all visible information on the passport to validate extracted values.
- Carefully inspect digits that are commonly misread by OCR: 0/O, 1/I/l, 5/S, 8/B, 2/Z.
- Verify all dates and numbers character-by-character before returning them.

Critical Field Triple-Extraction
For passportNumber and israeliIdNumber specifically, perform THREE independent extractions from different regions of the image:
1. From the printed/visual fields on the document face.
2. From the Machine Readable Zone (MRZ) at the bottom of the passport.
3. From any barcode, stamp, or secondary printed location visible.
If all three agree, return the value with high confidence. If any disagree, flag the discrepancy in warnings and return the majority value (or null if no majority exists).

MRZ Is the Ground Truth for All Fields It Encodes
Israeli passports use the ICAO TD3 MRZ: two lines of 44 monospace characters at the bottom of the photo page. Because it uses a fixed-pitch OCR-B font with no ambiguity, the MRZ is MORE reliable than the printed human-readable fields. For every field below, decode it from the MRZ first, then use the printed field only as a secondary cross-check.

TD3 MRZ layout (count characters left-to-right, starting at 1):

Line 1 (44 chars):
  1–2   : Document type (e.g. "PP")
  3–5   : Issuing country code (e.g. "ISR")
  6–44  : Names — format: SURNAME<<GIVEN1<GIVEN2<...
          Split on "<<": left part = surname, right part = given names (replace remaining "<" with space)

Line 2 (44 chars):
  1–9   : Passport number (9 chars, may include trailing "<" filler)
  10    : Check digit for passport number
  11–13 : Nationality code (3-letter, e.g. "ISR")
  14–19 : Date of birth (YYMMDD)
  20    : Check digit for date of birth
  21    : Sex ("M", "F", or "<" for unspecified)
  22–27 : Expiry date (YYMMDD)
  28    : Check digit for expiry date
  29–42 : Optional data — for Israeli passports this is the national ID number
          Strip all "<" filler characters and hyphens; keep digits only
  43    : Check digit for optional data
  44    : Overall composite check digit

Decoding rules:
- Dates (YYMMDD): year 00–30 = 2000–2030; year 31–99 = 1931–1999. Convert to YYYY-MM-DD.
  Example: "110101" → 2011-01-11
- Passport number: strip trailing "<" filler. Preserve any letters.
- Names: replace "<" within a name segment with a space, then trim.
- National ID (pos 29–42): strip all "<" and "-"; keep digits only.

MRZ overrides printed field on conflict:
- If the MRZ value and the printed value disagree for ANY field, TRUST THE MRZ value.
- Add a warning entry describing the discrepancy (e.g. "Printed DOB 2014-01-11 overridden by MRZ value 2011-01-11").
- Never silently use the printed value when the MRZ says something different.
- If the MRZ check digit for a field FAILS: return null for that field (do not fall back to the printed value either) and add a warning such as "passportNumber MRZ check digit failed — field omitted".

Fields where MRZ is authoritative:
- passportNumber → MRZ line 2, pos 1–9 (strip trailing "<")
- surname        → MRZ line 1, pos 6–44, left of "<<"
- givenNames     → MRZ line 1, pos 6–44, right of "<<", "<" → space
- nationality    → MRZ line 2, pos 11–13 (map ISR → "Israel", etc.)
- sex            → MRZ line 2, pos 21
- dateOfBirth    → MRZ line 2, pos 14–19 (YYMMDD → YYYY-MM-DD)
- dateOfExpiry   → MRZ line 2, pos 22–27 (YYMMDD → YYYY-MM-DD)
- israeliIdNumber→ MRZ line 2, pos 29–42 (digits only)

Fields NOT in MRZ (use printed face only):
- placeOfBirth
- dateOfIssue

Normalization Rules
- Extract names exactly as printed in English. Preserve capitalization exactly as shown.
- Convert dates to ISO format (YYYY-MM-DD).
- For Israeli ID numbers: extract only digits, remove hyphens, spaces, and separators.
  Examples: 3-2779442-6 → 327794426 | 3-3151008-1 → 331510081
- For passport numbers: preserve letters and digits, remove spaces.
- Do not transliterate Hebrew names.
- Do not infer missing values.

Fields to Extract
Return a JSON object with exactly these keys:
{
  "passportNumber": string or null,
  "surname": string or null,
  "givenNames": string or null,
  "fullName": string or null,
  "nationality": string or null,
  "sex": string or null,
  "dateOfBirth": string or null,
  "placeOfBirth": string or null,
  "dateOfIssue": string or null,
  "dateOfExpiry": string or null,
  "israeliIdNumber": string or null,
  "warnings": []
}

Field Mapping
- passportNumber = Passport No.
- surname = Surname / Family Name
- givenNames = Given Name(s)
- fullName = Given Name(s) + space + Surname
- nationality = Nationality (English country name as printed)
- sex = Sex — single letter "M" or "F" only
- dateOfBirth = Date of Birth (YYYY-MM-DD)
- placeOfBirth = Place of Birth
- dateOfIssue = Date of Issue (YYYY-MM-DD)
- dateOfExpiry = Date of Expiry (YYYY-MM-DD)
- israeliIdNumber = I.D. No. (digits only, no hyphens)

Verification Checklist (complete before returning)
- Decode ALL MRZ fields first, then cross-check against the printed face.
- Validate MRZ check digits for passport number (pos 10), DOB (pos 20), and expiry (pos 28).
  If a check digit fails: return null for that field and add a warning explaining the failure.
  Do NOT return the value even if it looks plausible — a failed check digit means the read is unreliable.
- Verify passportNumber matches between MRZ pos 1–9 and the printed "Passport No." field.
- Verify israeliIdNumber matches between MRZ pos 29–42 and the printed "I.D. No." field.
- Verify dateOfBirth: MRZ pos 14–19 is ground truth; flag any mismatch with printed date.
- Verify dateOfExpiry: MRZ pos 22–27 is ground truth; flag any mismatch with printed date.
- Verify names from MRZ line 1 match the printed surname and given name fields.
- Ensure israeliIdNumber contains digits only (no hyphens, no letters).
- Ensure all dates are valid calendar dates (e.g. no Feb 30).
- Ensure fullName equals givenNames + " " + surname.

Output Requirements
- Return only a valid JSON object.
- Do not return explanations, markdown, OCR confidence scores, or any text before or after the JSON.
- If any field is unclear, return null and explain the reason in the warnings array.`

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
