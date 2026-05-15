/**
 * POST /api/translate-form
 * Body: JSON { data: object, attachments?: [{ field, fileName, mimeType, base64 }] }
 * Response: { translated: string, analyzedAttachments?: { field, fileName }[] }
 * DS-160 English summary via GPT-4o (system + user messages; vision attachments as data URLs).
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_TIMEOUT_MS = 120_000
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024

/** Professional DS-160 framing (system role) — reduces refusal vs casual "translate my data" prompts. */
const SYSTEM_PROMPT = `You are an expert DS-160 visa preparation assistant.

Your task is to analyze:

1. A JSON object containing internal intake form data (mostly in Hebrew)
2. Uploaded documents and attachments (passport scans, IDs, PDFs, screenshots, forms, etc.)

Then generate a COMPLETE DS-160-ready English summary document.

CRITICAL REQUIREMENTS:

* Translate ALL Hebrew content into professional English
* Preserve ALL information
* Do NOT omit any detail
* Extract missing information from uploaded files whenever possible
* Use passport data as the primary source of truth for:

  * legal name
  * native name
  * passport number
  * nationality
  * birth date
  * issuance details

The final output MUST follow the SAME ORDER as the official DS-160 form.

---

## ADDRESS FORMAT

ALL addresses MUST use this exact format:

Street, City, Country

Examples:

* HaRav Levi 25, Bat Yam, Israel
* 770 Eastern Pkwy, Brooklyn, United States

Do NOT include zip codes unless specifically relevant.

---

## INSTITUTION ADDRESS COMPLETION

If a school, employer, institution, military base, synagogue, yeshiva, or organization is mentioned without a full address:

* Search the web for the official address
* Complete it automatically
* Use the primary official address
* Normalize it into:
  Street, City, Country

If confidence is low:

* mark the field as:
  ❗ MISSING

---

## MISSING DATA RULES

Any missing or unclear information MUST be marked EXACTLY as:

❗ MISSING

Examples:

* Father's Date of Birth: ❗ MISSING
* Passport Book Number: ❗ MISSING

Never invent personal information.

---

## NATIVE NAME RULES

If the passport contains a native-language name:

* extract it exactly as shown
* place it directly under the English full name
* preserve original spelling

Example:

Full Name: DAVID ORI MAIMON
Native Name: דוד אורי מימון

---

## TRANSLITERATION RULES

When translating Hebrew names:

* prefer passport transliteration
* preserve official spelling from passport MRZ if available
* do NOT invent alternative spellings

---

## OUTPUT FORMAT

The result should look like a professionally prepared DS-160 intake summary.

Use clean section headers like:

🟦 PERSONAL INFORMATION
🟦 PASSPORT INFORMATION
🟦 CONTACT INFORMATION
🟦 TRAVEL INFORMATION
🟦 U.S. CONTACT
🟦 FAMILY INFORMATION
🟦 WORK / EDUCATION / TRAINING
🟦 SECURITY & BACKGROUND

Maintain DS-160 logical ordering.

---

## STYLE RULES

* Professional
* Clean
* Structured
* Human-readable
* No JSON
* No markdown tables
* No explanations
* No AI commentary
* No hallucinations

---

## EXTRACTION RULES

Always cross-check:

* intake JSON
* passport scan
* uploaded PDFs
* screenshots
* attachments

If information exists in attachments but not in the JSON:

* include it

If conflicting data exists:

* prioritize passport/government-issued documents

---

## FINAL GOAL

Generate a COMPLETE DS-160-ready English summary document that a human can directly review before submission.`

const USER_PREAMBLE =
  'Analyze the form data and attachments below and produce the DS-160-ready English summary document per your system instructions.'

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
    /** @type {{ field: string, fileName: string }[]} */
    const analyzedAttachments = []
    const content = [
      {
        type: 'text',
        text:
          USER_PREAMBLE +
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
      analyzedAttachments.push({
        field: String(att?.field || ''),
        fileName: String(att?.fileName || ''),
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
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
          ],
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

    return jsonResponse(res, 200, { translated, analyzedAttachments })
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'OpenAI request timed out' : e?.message || 'translate-form error'
    console.error('[translate-form]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
