/**
 * POST /api/extract-passport
 * Raw image body (same pattern as /api/upload): Content-Type = image/* or application/pdf.
 * Uses OpenAI GPT-4o vision to extract passport fields as JSON.
 */

const MAX_BYTES = 10 * 1024 * 1024 // 10 MiB — images are resized client-side; PDFs may still be large
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
const FOREIGN_PASSPORT_SYSTEM_PROMPT = `You are an expert passport OCR engine.

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

const FOREIGN_PASSPORT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'foreign_passport_number',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        passportNumber:  { type: ['string', 'null'] },
        matched:         { type: 'boolean' },
        visualValue:     { type: ['string', 'null'] },
        mrzValue:        { type: ['string', 'null'] },
        mismatchDetails: { type: ['string', 'null'] },
      },
      required: ['passportNumber', 'matched', 'visualValue', 'mrzValue', 'mismatchDetails'],
      additionalProperties: false,
    },
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return jsonResponse(res, 405, { error: 'Method not allowed' })
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return jsonResponse(res, 503, { error: 'OpenAI not configured', code: 'OPENAI_DISABLED' })
  }

  // ?mode=foreign → extract only the passport number (cross-checked visual + MRZ)
  const url = new URL(req.url, 'http://localhost')
  if (url.searchParams.get('mode') === 'foreign') {
    return handleForeignMode(req, res, apiKey)
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

    // Step 3: call OpenAI Chat Completions (GPT-4o) with vision + structured output schema
    const PASSPORT_SYSTEM_PROMPT = `You are an expert OCR and document extraction engine specialized in Israeli biometric passports.

Your primary goal is accuracy, not completeness.

Never guess unreadable characters.
If a value cannot be read with high confidence, return null instead.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GENERAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Read the passport multiple times before producing the final answer.

Perform these passes independently:

PASS 1
Read every printed field normally.

PASS 2
Read every field again by its physical location on the passport.

PASS 3
Read the MRZ independently.

Only after all three passes should you reconcile the results.

Do not let information from one pass influence another.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OCR QUALITY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Inspect the passport at multiple zoom levels.

Read the entire passport once.

Then zoom into each individual field.

Pay special attention to small digits.

Watch carefully for commonly confused characters:

0 ↔ O
1 ↔ I ↔ l
2 ↔ Z
5 ↔ S
6 ↔ G
8 ↔ B

Never replace one character with another unless clearly visible.

Preserve names exactly as printed.

Do not normalize capitalization.

Do not correct spelling.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRINTED PASSPORT FIELDS (PASS 1)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Extract the following printed fields:

• Passport Number
• Surname
• Given Names
• Nationality
• Sex
• Date of Birth
• Place of Birth
• Date of Issue
• Date of Expiry
• Israeli ID Number
• Issuance City — the city where the passport was issued (look for labels such as "Authority", "Passport at", "Place of issue", or similar near the Date of Issue field).
• Issuance Country — the country that issued the passport. Prefer an explicit issuing-country label (e.g. "State of Israel") if present; otherwise infer from the issuing authority or the passport's country field.

Dates must use: YYYY-MM-DD

Israeli ID Number: Extract the complete identifier exactly as printed, ensuring no digits are omitted. Remove hyphens and all other separators from the returned value — return digits only. If unreadable return null.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SPATIAL VERIFICATION PASS (PASS 2)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use the known layout of an Israeli passport.

Read each field again directly from its expected position:

Passport Number:   Top-right corner.
Surname:           Upper-right, row 1 below header.
Given Names:       Upper-right, row 2.
Nationality:       Upper-right, row 3.
Israeli ID Number: Middle-right — labeled "I.D. No. / מס' זהות".
                   Format on document: D-DDDDDDD-D (9 digits with hyphens).
                   Extract the complete identifier exactly as printed, ensuring no digits are omitted.
                   Remove hyphens and all other separators — return digits only.
                   Do NOT confuse with Passport No. (top-right) or MRZ digit runs.
Date of Birth:     Center-left, below the photo.
Sex:               Same row as Date of Birth.
Place of Birth:    Same row as Date of Birth.
Date of Issue:     Lower-center.
Date of Expiry:    Lower-right, paired with Date of Issue.
Issuance City:     Adjacent to Date of Issue — typically labeled "Authority" or "Passport at".
Issuance Country:  The country printed as the issuer; on Israeli passports this is "State of Israel" or "Israel".

If this second reading differs from PASS 1, prefer the spatial reading and record a warning.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MRZ PASS (PASS 3)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Read the complete MRZ exactly as printed (two lines of monospace text at the bottom).

Return both raw lines exactly as seen (mrzLine1, mrzLine2).

Do not attempt to correct characters.

Then decode according to ICAO 9303 TD3 specifications:

Line 1 (44 chars):
  pos 1–2:   document type
  pos 3–5:   issuing country code
  pos 6–44:  names — split on "<<": left = surname, right = given names
             Replace remaining "<" with spaces, then trim.

Line 2 (44 chars):
  pos 1–9:   passport number (strip trailing "<")
  pos 10:    check digit (record but do not compute — just read)
  pos 11–13: nationality code (map ISR → "Israel")
  pos 14–19: date of birth YYMMDD → YYYY-MM-DD
             (year 00–30 = 2000–2030, year 31–99 = 1931–1999)
  pos 20:    check digit
  pos 21:    sex (M/F; "<" = null)
  pos 22–27: expiry date YYMMDD → YYYY-MM-DD
  pos 28:    check digit
  pos 29–42: optional data = Israeli national ID (strip all "<"; digits only)
  pos 43–44: check digits

Do NOT perform check digit calculations. Simply decode the text exactly as read.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECONCILIATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Compare printed OCR, spatial OCR, and MRZ decoding.

If values disagree, prefer in this order:

For passportNumber, surname, givenNames, nationality, sex, dateOfBirth, dateOfExpiry:
  → Prefer MRZ. If MRZ is null, use spatial. Record every disagreement in warnings.

For placeOfBirth, dateOfIssue, issuanceCity, issuanceCountry:
  → Use spatial printed value (not in MRZ).

For israeliIdNumber:
  → Prefer the MRZ optional data (pos 29–42) if readable.
  → Otherwise use the printed spatial value (I.D. No. field).
  → If both exist and disagree, prefer spatial and add a warning.

Record every disagreement in the warnings array.
fullName = givenNames + " " + surname (null if either is null).`

    // JSON schema enforced by the API (structured outputs) — keeps the prompt focused on OCR behaviour.
    const RESPONSE_SCHEMA = {
      type: 'json_schema',
      json_schema: {
        name: 'passport_extraction',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            printed: {
              type: 'object',
              properties: {
                passportNumber: { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                surname:        { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                givenNames:     { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                nationality:    { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                sex:            { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                dateOfBirth:    { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                placeOfBirth:   { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                dateOfIssue:    { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                dateOfExpiry:   { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                israeliIdNumber:{ type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                issuanceCity:   { type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
                issuanceCountry:{ type: 'object', properties: { value: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['value', 'confidence'], additionalProperties: false },
              },
              required: ['passportNumber','surname','givenNames','nationality','sex','dateOfBirth','placeOfBirth','dateOfIssue','dateOfExpiry','israeliIdNumber','issuanceCity','issuanceCountry'],
              additionalProperties: false,
            },
            spatial: {
              type: 'object',
              properties: {
                passportNumber:  { type: ['string', 'null'] },
                surname:         { type: ['string', 'null'] },
                givenNames:      { type: ['string', 'null'] },
                nationality:     { type: ['string', 'null'] },
                sex:             { type: ['string', 'null'] },
                dateOfBirth:     { type: ['string', 'null'] },
                placeOfBirth:    { type: ['string', 'null'] },
                dateOfIssue:     { type: ['string', 'null'] },
                dateOfExpiry:    { type: ['string', 'null'] },
                israeliIdNumber: { type: ['string', 'null'] },
                issuanceCity:    { type: ['string', 'null'] },
                issuanceCountry: { type: ['string', 'null'] },
              },
              required: ['passportNumber','surname','givenNames','nationality','sex','dateOfBirth','placeOfBirth','dateOfIssue','dateOfExpiry','israeliIdNumber','issuanceCity','issuanceCountry'],
              additionalProperties: false,
            },
            mrz: {
              type: 'object',
              properties: {
                mrzLine1:        { type: ['string', 'null'] },
                mrzLine2:        { type: ['string', 'null'] },
                passportNumber:  { type: ['string', 'null'] },
                surname:         { type: ['string', 'null'] },
                givenNames:      { type: ['string', 'null'] },
                nationality:     { type: ['string', 'null'] },
                sex:             { type: ['string', 'null'] },
                dateOfBirth:     { type: ['string', 'null'] },
                dateOfExpiry:    { type: ['string', 'null'] },
                israeliIdNumber: { type: ['string', 'null'] },
              },
              required: ['mrzLine1','mrzLine2','passportNumber','surname','givenNames','nationality','sex','dateOfBirth','dateOfExpiry','israeliIdNumber'],
              additionalProperties: false,
            },
            final: {
              type: 'object',
              properties: {
                passportNumber:  { type: ['string', 'null'] },
                surname:         { type: ['string', 'null'] },
                givenNames:      { type: ['string', 'null'] },
                fullName:        { type: ['string', 'null'] },
                nationality:     { type: ['string', 'null'] },
                sex:             { type: ['string', 'null'] },
                dateOfBirth:     { type: ['string', 'null'] },
                placeOfBirth:    { type: ['string', 'null'] },
                dateOfIssue:     { type: ['string', 'null'] },
                dateOfExpiry:    { type: ['string', 'null'] },
                israeliIdNumber: { type: ['string', 'null'] },
                issuanceCity:    { type: ['string', 'null'] },
                issuanceCountry: { type: ['string', 'null'] },
              },
              required: ['passportNumber','surname','givenNames','fullName','nationality','sex','dateOfBirth','placeOfBirth','dateOfIssue','dateOfExpiry','israeliIdNumber','issuanceCity','issuanceCountry'],
              additionalProperties: false,
            },
            ambiguities: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field:        { type: 'string' },
                  position:     { type: 'number' },
                  alternatives: { type: 'array', items: { type: 'string' } },
                },
                required: ['field', 'position', 'alternatives'],
                additionalProperties: false,
              },
            },
            warnings: { type: 'array', items: { type: 'string' } },
          },
          required: ['printed', 'spatial', 'mrz', 'final', 'ambiguities', 'warnings'],
          additionalProperties: false,
        },
      },
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
          model: 'gpt-4.1',
          max_tokens: 2500,
          response_format: RESPONSE_SCHEMA,
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
                  text: 'Extract all passport fields from this image.',
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

    // Pull reconciled values from the `final` object (structured output guarantee)
    const f = extracted.final ?? {}
    const sexRaw = String(f.sex ?? '').trim().toUpperCase().slice(0, 1)
    const sex = sexRaw === 'M' || sexRaw === 'F' ? sexRaw : ''

    const nationalIdDigits = String(f.israeliIdNumber ?? '').replace(/[-\s]/g, '').trim()
    const isIsraeli = /^israel$/i.test(String(f.nationality ?? '').trim())

    // Format passportBookNumber as D-DDDDDDD-D only for Israeli passports with a valid 9-digit ID
    let passportBookNumber
    if (isIsraeli && /^\d{9}$/.test(nationalIdDigits)) {
      passportBookNumber = `${nationalIdDigits.slice(0, 1)}-${nationalIdDigits.slice(1, 8)}-${nationalIdDigits.slice(8)}`
    }

    const out = {
      firstName:          String(f.givenNames ?? '').trim(),
      lastName:           String(f.surname ?? '').trim(),
      birthDate:          String(f.dateOfBirth ?? '').trim(),
      passportNumber:     String(f.passportNumber ?? '').trim(),
      issuingCountry:     String(f.nationality ?? '').trim(),
      sex,
      nationalId:         nationalIdDigits,
      passportBookNumber,
      placeOfBirth:       String(f.placeOfBirth ?? '').trim() || undefined,
      dateOfIssue:        String(f.dateOfIssue ?? '').trim() || undefined,
      dateOfExpiry:       String(f.dateOfExpiry ?? '').trim() || undefined,
      issuanceCity:       String(f.issuanceCity ?? '').trim() || undefined,
      issuanceCountry:    String(f.issuanceCountry ?? '').trim() || undefined,
      warnings:           Array.isArray(extracted.warnings) ? extracted.warnings : [],
      ambiguities:        Array.isArray(extracted.ambiguities) ? extracted.ambiguities : [],
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

async function handleForeignMode(req, res, apiKey) {
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
          response_format: FOREIGN_PASSPORT_SCHEMA,
          messages: [
            { role: 'system', content: FOREIGN_PASSPORT_SYSTEM_PROMPT },
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
      console.error('[extract-passport?mode=foreign] OpenAI error', openaiRes.status, rawText.slice(0, 500))
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
      passportNumber:  extracted.passportNumber ?? null,
      matched:         extracted.matched ?? false,
      visualValue:     extracted.visualValue ?? null,
      mrzValue:        extracted.mrzValue ?? null,
      mismatchDetails: extracted.mismatchDetails ?? null,
    })
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'OpenAI request timed out' : e?.message || 'extract-passport error'
    console.error('[extract-passport?mode=foreign]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
