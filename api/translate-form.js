/**
 * POST /api/translate-form
 * Body: JSON { data, attachments?, fileMeta?, s3Documents? }
 * — attachments: [{ field, fileName, mimeType, base64 }] from browser File blobs
 * — s3Documents: [{ field, key, bucket? }] fills any missing doc slot from S3 (same keys as /api/upload)
 * Response: { translated, analyzedAttachments, pdfBase64 }
 */

import { buildTranslationPdf } from './lib/buildTranslationPdf.js'
import { fetchS3FormDocumentBytes } from './lib/s3FormDocuments.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_TIMEOUT_MS = 180_000
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

For **every** school, employer, company, university, yeshiva, synagogue, military unit, or organization mentioned in the form JSON or attachments:

* You **must** supply a complete physical address in **Street, City, Country** format (see ADDRESS FORMAT above).
* **Use web search** to find the official primary / headquarters address when the user did not provide one.
* If several branches exist, pick the main headquarters or the best-known official site address.
* Only mark **❗ MISSING** if, after searching, you still cannot determine a reasonable address with acceptable confidence.

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

## MANDATORY EMBEDDED DOCUMENT CONTENT (NON-NEGOTIABLE)

Whenever the user message includes image or PDF attachments (passport, visa, Social Security card, license, etc.):

* You MUST produce **one** continuous English document. The **text of what appears on those scans** must live **inside** that document — not as a vague reference ("see attached") and not as a separate deliverable.
* You MUST include a dedicated section in the output, placed after the main DS-160-ordered blocks (before any closing notes), with this exact title line:

  🟦 SUPPORTING DOCUMENT TRANSCRIPTIONS

* Under that title, for **each** attachment bracket you see in the user message (e.g. [Attachment: passportScan — photo.jpg]), output a block with:

  1. A header line: **Document:** <form field name> — <original file name>
  2. **Transcription:** Every legible printed or handwritten line you can read from that scan, in English (translate Hebrew/other languages; keep MRZ lines, numbers, dates, and document codes as accurate character strings).
  3. **Mapped to DS-160:** 3–10 bullets tying those transcribed facts to the fields you stated earlier (passport #, dates, names, issuing authority, visa class, SSN last-4 if policy-appropriate, license state/number, etc.). If something cannot be read, write ❗ MISSING for that sub-item only.

* Facts you take from scans MUST also appear in the relevant earlier DS-160 sections; the transcription section is the audit trail proving the scan was read and merged into the summary.

* Never tell the reviewer to open external files or "refer to the upload" — everything needed for review must appear in this single text output.

---

## COMBINED PDF DELIVERABLE (SERVER-ASSEMBLED)

After your English reply is generated, the system **automatically builds one PDF file** that contains:

1. **Printable pages** with your full English DS-160 summary (this text).
2. **Then full-page, full-color embedded copies** of each uploaded photograph (JPEG/PNG) and **embedded pages** from any uploaded PDF—so the reviewer sees the **actual scans inside the same PDF**, not links or thumbnails-only.

When you list documents in **🟦 SUPPORTING DOCUMENT TRANSCRIPTIONS**, use the same order as the form fields when possible: **passportScan**, **existingVisaScan**, **socialSecurityScan**, **americanLicenseScan**, then **extraDocumentScan1**, **extraDocumentScan2**, **extraDocumentScan3** (ad-hoc uploads)—so the written audit trail matches the visual appendix in the PDF.

The server may attach the same four document types from cloud storage (S3) when the JSON lists saved keys but the browser did not send base64 bytes. Treat those images/PDFs exactly like user attachments: transcribe them, map them to DS-160, and assume they appear in the PDF appendix.

---

## ATTACHMENT-DRIVEN GAP FILLING (WHEN SCANS EXIST)

The intake JSON may omit facts that are visible on uploads. Whenever **passportScan**, **existingVisaScan**, **socialSecurityScan**, **americanLicenseScan**, or any **extraDocumentScan1–3** attachment is available (inline attachment or server-loaded from S3):

* **passportScan:** Use as primary source of truth for legal English names, native name if printed, date of birth, passport number, issuing country / authority, nationality, sex (MRZ or visual), and national ID if shown. If a JSON field is empty or clearly wrong, prefer the scan when legible.

* **existingVisaScan:** Read the visa foil (class/type, control numbers, post name, issue and expiration dates, entries). If JSON fields for prior U.S. visa or travel dates (e.g. last visa issue/expiration, prior visits) are empty or marked ❗ MISSING, populate them from the visa when you can read them confidently; otherwise keep ❗ MISSING.

* **socialSecurityScan:** If Social Security–related text in the summary would be empty but the card is readable, supply the SSN string exactly as on the card (preserve formatting). Never guess obscured digits—use ❗ MISSING for the whole number if any digit is uncertain.

* **americanLicenseScan:** If license number, issuing U.S. state or jurisdiction, class, or expiration appear on the card but are missing from the JSON, add them from the scan when legible.

* **extraDocumentScan1 / extraDocumentScan2 / extraDocumentScan3:** Ad-hoc uploads. Transcribe legible content and map facts to the nearest DS-160 sections; if they only support a narrative, include them under a short **Supplemental documents** note within the main flow before 🟦 SUPPORTING DOCUMENT TRANSCRIPTIONS.

Always merge these facts into the main DS-160-ordered sections first; **🟦 SUPPORTING DOCUMENT TRANSCRIPTIONS** remains the audit trail for each file.

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

Generate a COMPLETE DS-160-ready English summary document that a human can directly review before submission. If attachments were provided, that document MUST include the 🟦 SUPPORTING DOCUMENT TRANSCRIPTIONS section with full in-body transcriptions as specified above. Assume the final exported PDF will include those same files as visually embedded pages after your text.`

const USER_PREAMBLE =
  'Analyze the form data and attachments below and produce the DS-160-ready English summary document per your system instructions. ' +
  'If there are image/PDF attachments (including any loaded from S3 on the server), the final text must embed their readable content: include the mandatory 🟦 SUPPORTING DOCUMENT TRANSCRIPTIONS section with per-file transcriptions and DS-160 mapping bullets — do not ask the reader to open files elsewhere. ' +
  'Use scans to fill gaps in the JSON where the instructions allow (visa dates, license details, SSN from card, passport identity fields). ' +
  'A combined PDF will be produced automatically: your English text as pages, then full-page embedded copies of each upload—keep transcription blocks ordered to match passportScan, existingVisaScan, socialSecurityScan, americanLicenseScan, then extraDocumentScan1–3 when applicable.'

const UPLOAD_DOC_FIELDS = [
  'passportScan',
  'existingVisaScan',
  'socialSecurityScan',
  'americanLicenseScan',
  'extraDocumentScan1',
  'extraDocumentScan2',
  'extraDocumentScan3',
]

/**
 * @param {string} name
 */
function guessMimeFromFileName(name) {
  const n = String(name ?? '').toLowerCase()
  if (n.endsWith('.pdf')) return 'application/pdf'
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.gif')) return 'image/gif'
  if (n.endsWith('.webp')) return 'image/webp'
  return ''
}

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
    /** @type {{ field: string, fileName: string, mimeType: string, bytes: Uint8Array }[]} */
    const binaryAttachments = []
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
      try {
        const buf = Buffer.from(b64, 'base64')
        binaryAttachments.push({
          field: String(att?.field || ''),
          fileName: String(att?.fileName || ''),
          mimeType: mime.toLowerCase(),
          bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        })
      } catch {
        /* skip binary if decode fails */
      }
    }

    const fieldsAttached = new Set(analyzedAttachments.map((a) => a.field).filter(Boolean))
    const s3List = Array.isArray(body.s3Documents) ? body.s3Documents : []

    for (const field of UPLOAD_DOC_FIELDS) {
      if (fieldsAttached.has(field)) continue
      const meta = s3List.find((d) => d && String(d.field) === field && String(d.key || '').trim())
      if (!meta) continue
      const got = await fetchS3FormDocumentBytes(String(meta.key))
      if (!got?.bytes?.length) continue
      let mime = String(got.contentType || '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      if (!mime || mime === 'application/octet-stream') {
        mime = guessMimeFromFileName(got.fileName) || 'image/jpeg'
      }
      const allowed = /^image\/(jpeg|png|gif|webp)$|^application\/pdf$/i
      if (!allowed.test(mime)) continue
      if (got.bytes.length > MAX_ATTACHMENT_BYTES) {
        console.warn('[translate-form] S3 attachment skipped (too large)', field)
        continue
      }
      const b64 = Buffer.from(got.bytes).toString('base64')
      const fileName = got.fileName || `${field}.bin`
      content.push({
        type: 'text',
        text: `\n[Attachment: ${field} — ${fileName} (from S3)]`,
      })
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` },
      })
      analyzedAttachments.push({ field, fileName })
      binaryAttachments.push({
        field,
        fileName,
        mimeType: mime.toLowerCase(),
        bytes: got.bytes,
      })
      fieldsAttached.add(field)
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
          // Vision attachments require a vision-capable model. `gpt-4o-search-preview` is text-only and would skip image analysis.
          model: 'gpt-4o',
          max_tokens: 16_384,
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

    const orderIdx = (f) => {
      const i = UPLOAD_DOC_FIELDS.indexOf(String(f || ''))
      return i === -1 ? 99 : i
    }
    binaryAttachments.sort((a, b) => orderIdx(a.field) - orderIdx(b.field))
    analyzedAttachments.sort((a, b) => orderIdx(a.field) - orderIdx(b.field))

    let pdfBase64 = ''
    try {
      const pdfBytes = await buildTranslationPdf(translated, binaryAttachments)
      pdfBase64 = Buffer.from(pdfBytes).toString('base64')
    } catch (pdfErr) {
      console.error('[translate-form] PDF assembly failed', pdfErr)
    }

    return jsonResponse(res, 200, { translated, analyzedAttachments, pdfBase64 })
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'OpenAI request timed out' : e?.message || 'translate-form error'
    console.error('[translate-form]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
