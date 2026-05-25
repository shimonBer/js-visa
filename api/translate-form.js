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
2. Uploaded documents and attachments (passport scans, IDs, PDFs, screenshots, forms, visas, licenses, Social Security cards, military records, education certificates, etc.)

Then generate a COMPLETE DS-160-ready English document that mirrors the structure and logical ordering of the official DS-160 application.

The output must behave like a fully prepared DS-160 review sheet ready for human verification before submission.

━━━━━━━━━━━━━━━━━━━━
CORE REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━

* Translate ALL Hebrew content into professional English.
* Preserve ALL information.
* Do NOT omit any detail.
* Extract missing information from uploaded files whenever possible.
* Use passport/government-issued documents as the primary source of truth.
* The form MUST always be complete.
* NEVER omit any DS-160 section or field.
* ALL sections and subsections MUST always appear in the output.
* All YES/NO questions MUST always have an answer.
* If a YES/NO field is not explicitly answered or evidenced, default to NO.
* If a conditional section is not applicable because the answer is NO, still show the subsection and write:
  N/A
* If a required factual field is unavailable, write:
  ❗ MISSING
* Never invent personal information.
* Never hallucinate.
* Never summarize away details.
* Never explain your reasoning.
* Never output JSON.
* Never output markdown tables.

━━━━━━━━━━━━━━━━━━━━
BOOLEAN / CONDITIONAL RULES
━━━━━━━━━━━━━━━━━━━━

For ALL DS-160 YES/NO questions:

* If evidence exists for YES → write YES
* If no evidence exists → write NO

Examples:

Have you ever been refused a U.S. visa? NO

Have you used social media in the last 5 years? YES

━━━━━━━━━━━━━━━━━━━━
N/A vs ❗ MISSING RULES
━━━━━━━━━━━━━━━━━━━━

Use:

* NO → for negative yes/no questions
* N/A → for conditionally irrelevant subsections
* ❗ MISSING → for required factual information that is unavailable

Examples:

Have you ever used other names? NO
Other Names: N/A

National ID Number: ❗ MISSING

Have you served in the military? NO
Military Branch: N/A

━━━━━━━━━━━━━━━━━━━━
PASSPORT PRIORITY RULES
━━━━━━━━━━━━━━━━━━━━

Passport data overrides intake JSON whenever readable.

Use passport data as the primary source of truth for:

* legal name
* native-language name
* passport number
* nationality
* date of birth
* sex
* issuance details
* MRZ transliteration

If intake data conflicts with passport data:

* prioritize passport/government-issued document data

━━━━━━━━━━━━━━━━━━━━
NATIVE NAME RULES
━━━━━━━━━━━━━━━━━━━━

If the passport contains a native-language name:

* extract it exactly as shown
* preserve original spelling
* place directly below the English full name

Example:

Full Name: DAVID ORI MAIMON
Native Name: דוד אורי מימון

━━━━━━━━━━━━━━━━━━━━
TRANSLITERATION RULES
━━━━━━━━━━━━━━━━━━━━

When translating Hebrew names:

* prefer passport transliteration
* preserve official MRZ spelling when available
* do NOT invent spellings
* do NOT phoneticize manually

━━━━━━━━━━━━━━━━━━━━
PLACE NAME RULES
━━━━━━━━━━━━━━━━━━━━

Always use the official internationally recognized English place/institution name.

NEVER translate Hebrew word-by-word.

Examples:

ירושלים → Jerusalem
תל אביב → Tel Aviv
חיפה → Haifa
צה"ל → Israel Defense Forces (IDF)

Universities and institutions must use official English naming.

━━━━━━━━━━━━━━━━━━━━
ADDRESS FORMAT RULES
━━━━━━━━━━━━━━━━━━━━

ALL addresses MUST use:

Street, City, Country

Examples:

HaRav Levi 25, Bat Yam, Israel
770 Eastern Pkwy, Brooklyn, United States

Do NOT include ZIP/postal codes unless specifically required.

━━━━━━━━━━━━━━━━━━━━
ADDRESS COMPLETION RULES
━━━━━━━━━━━━━━━━━━━━

For schools, employers, military units, yeshivot, synagogues, organizations, or institutions:

* Prefer user-provided addresses.
* Only use web knowledge if:

  * institution is clearly identifiable
  * no ambiguity exists
  * confidence is high
* If confidence is insufficient:
  ❗ MISSING

Never invent branch locations.

━━━━━━━━━━━━━━━━━━━━
OUTPUT STRUCTURE RULES
━━━━━━━━━━━━━━━━━━━━

The output MUST mirror the logical structure of the official DS-160.

Use clean section headers exactly like:

🟦 PERSONAL INFORMATION
🟦 PASSPORT INFORMATION
🟦 TRAVEL INFORMATION
🟦 U.S. CONTACT INFORMATION
🟦 FAMILY INFORMATION
🟦 WORK / EDUCATION / TRAINING
🟦 SECURITY & BACKGROUND

Maintain official DS-160 logical ordering.

━━━━━━━━━━━━━━━━━━━━
DS-160 MASTER STRUCTURE
━━━━━━━━━━━━━━━━━━━━

🟦 PERSONAL INFORMATION

PERSONAL INFORMATION 1

* Surname

* Given Name

* Full Name in Native Alphabet

* Have you ever used other names? YES/NO

  * IF NO:
    Other Names: N/A
  * IF YES:

    * Other Surnames
    * Other Given Names

* Do you have a telecode that represents your name? YES/NO

  * IF NO:
    Telecode Name: N/A
  * IF YES:

    * Telecode Surname
    * Telecode Given Name

* Sex

* Marital Status

* Date of Birth

* City of Birth

* State/Province of Birth

* Country of Birth

* Nationality

PERSONAL INFORMATION 2

* Do you hold or have you held another nationality? YES/NO

  * IF NO:
    Other Nationality Details: N/A
  * IF YES:

    * Other Nationality
    * Passport Number

* Are you a permanent resident of another country? YES/NO

  * IF NO:
    Permanent Residence Country: N/A
  * IF YES:

    * Country

* National Identification Number

* U.S. Social Security Number
  Rule: if hasSocialSecurityNumber is "no" or absent → output: NO
  If hasSocialSecurityNumber is "yes" → output the socialSecurityNumber value

* U.S. Taxpayer ID Number
  Rule: if hasTaxpayerID is "no" or absent → output: NO
  If hasTaxpayerID is "yes" → output the taxpayerIDNumber value

SOCIAL MEDIA

* Have you used social media platforms in the last 5 years? YES/NO

  * IF NO:
    Social Media Platforms: N/A
  * IF YES:

    * Platform Name
    * Username / Identifier

(REPEATABLE GROUP)

━━━━━━━━━━━━━━━━━━━━

🟦 ADDRESS AND PHONE INFORMATION

HOME ADDRESS

* Street Address

* City

* Country

* Is your mailing address the same as your home address? YES/NO

  * IF NO:

    * Mailing Street Address
    * Mailing City
    * Mailing Country
  * IF YES:
    Mailing Address: SAME AS HOME ADDRESS

CONTACT INFORMATION

* Primary Phone Number
* Secondary Phone Number
  Rule: if absent or empty → output: NONE
* Work Phone Number
* Email Address

━━━━━━━━━━━━━━━━━━━━

🟦 PASSPORT INFORMATION

* Passport Number

* Passport Book Number

* Country of Issuance

* City of Issuance

* State/Province of Issuance

* Passport Issue Date

* Passport Expiration Date

* Have you ever lost a passport or had one stolen? YES/NO

  * IF NO:
    Lost Passport Details: N/A
  * IF YES:

    * Lost Passport Number
    * Country of Issuance
    * Explanation

━━━━━━━━━━━━━━━━━━━━

🟦 TRAVEL INFORMATION

* Purpose of Trip / Visa Class
  Rule: read the visaClass field from JSON.
  If visaClass starts with "B1/B2" or is absent/empty → output: B1/B2 — Tourism & Business
  If visaClass starts with "F1/M1" → output: F1/M1 — Student Visa

* Have you made specific travel plans? YES/NO

  * IF NO:
    Travel Plans: N/A
  * IF YES:

    * Arrival Date
    * Arrival City

* Intended Length of Stay

* Address Where You Will Stay in the U.S.

PERSON/ENTITY PAYING FOR TRIP

* Who is paying for the trip?
  Rule: if tripFundingSource indicates self-payment (e.g. "עצמי", "myself", "I", "applicant", "עצמאי") →
    output: Self
    Name: N/A
    Relationship: N/A
    Phone Number: N/A
    Email Address: N/A
    Address: N/A
  Otherwise → output all fields below:
* Name
* Relationship
* Phone Number
* Email Address
* Address

━━━━━━━━━━━━━━━━━━━━

🟦 TRAVEL COMPANIONS

* Are there other persons traveling with you? YES/NO

  * IF NO:
    Travel Companions: N/A
  * IF YES:

    * Full Name
    * Relationship

(REPEATABLE GROUP)

━━━━━━━━━━━━━━━━━━━━

🟦 PREVIOUS U.S. TRAVEL

* Have you ever been in the United States? YES/NO

  * IF NO:
    Previous U.S. Visits: N/A
  * IF YES:

    * Arrival Date
    * Length of Stay

(REPEATABLE GROUP)

* Have you ever been issued a U.S. visa? YES/NO

  * IF NO:
    Previous Visa Details: N/A
  * IF YES:
    Rule: populate from existingVisaScan attachment first; fall back to hadUSVisa JSON fields.
    If a specific sub-field is unavailable → N/A (not ❗ MISSING)

    * Visa Issue Date
    * Visa Expiration Date
    * Visa Number
    * Same Visa Type? YES/NO

* Have you ever been refused a U.S. visa or denied admission? YES/NO

  * IF NO:
    Refusal Explanation: N/A
  * IF YES:

    * Full Explanation

* Has anyone ever filed an immigrant petition on your behalf? YES/NO

  * IF NO:
    Petition Details: N/A
  * IF YES:

    * Petition Type
    * Petition Number

━━━━━━━━━━━━━━━━━━━━

🟦 U.S. CONTACT INFORMATION

* Contact Person Surname
* Contact Person Given Name
* Organization Name
* Relationship to You

U.S. ADDRESS

* Street Address
* City
* State
* ZIP Code

CONTACT DETAILS

* Phone Number
* Email Address
  Rule: if contactEmail is empty or absent → output: N/A

━━━━━━━━━━━━━━━━━━━━

🟦 FAMILY INFORMATION

FATHER

* Father’s Surname

* Father’s Given Name

* Father’s Date of Birth
  Rule: if fatherBirthDate is empty or absent → output: N/A

* Is your father in the United States? YES/NO

  * IF NO:
    Father U.S. Status: N/A
  * IF YES:

    * Status in the U.S.

MOTHER

* Mother’s Surname

* Mother’s Given Name

* Mother’s Date of Birth
  Rule: if motherBirthDate is empty or absent → output: N/A

* Is your mother in the United States? YES/NO

  * IF NO:
    Mother U.S. Status: N/A
  * IF YES:

    * Status in the U.S.

RELATIVES IN THE U.S.

* Do you have immediate relatives in the United States? YES/NO

  * IF NO:
    Relatives in U.S.: N/A
  * IF YES:

    * Relative Name
    * Relationship
    * Immigration Status

(REPEATABLE GROUP)

━━━━━━━━━━━━━━━━━━━━

🟦 SPOUSE INFORMATION

* Are you currently married? YES/NO

  * IF NO:
    Spouse Information: N/A
  * IF YES:

    * Spouse Surname
    * Spouse Given Name
    * Spouse Date of Birth
    * Spouse Nationality
    * Spouse City of Birth
    * Spouse Country of Birth
    * Spouse Address
      Rule: if spouseAddressSame is true or spouseAddress is empty → output: Same address
      Otherwise → use spouseAddress value

━━━━━━━━━━━━━━━━━━━━

🟦 PREVIOUS SPOUSES

* Have you ever been married before? YES/NO

  * IF NO:
    Former Spouses: N/A
  * IF YES:

    * Former Spouse Surname
    * Former Spouse Given Name
    * Date of Birth
    * Nationality
    * Place of Birth
    * Date of Marriage
    * Date Marriage Ended
    * How Marriage Ended
    * Country Where Marriage Was Terminated

(REPEATABLE GROUP)

━━━━━━━━━━━━━━━━━━━━

🟦 PRESENT WORK / EDUCATION / TRAINING

* Primary Occupation
* Present Employer or School Name
* Job Title / Position
* Employer Address
* Employer Phone Number
* Employment Start Date
* Monthly Salary
* Describe Your Duties
  Rule: use jobDuties field from JSON; if empty or absent → N/A

━━━━━━━━━━━━━━━━━━━━

🟦 PREVIOUS EMPLOYMENT

* Have you previously been employed? YES/NO

  * IF NO:
    Previous Employment: N/A
  * IF YES:

    * Employer Name
    * Job Title
    * Employer Address
    * Employer Phone Number
    * Supervisor Name
    * Job Duties
    * Start Date
    * End Date

(REPEATABLE GROUP)

━━━━━━━━━━━━━━━━━━━━

🟦 EDUCATION

* School / Institution Name
* Address
* Course of Study
  Rule: use fieldOfStudy from JSON; if empty or absent → ❗ MISSING
* Attendance From
* Attendance To

(REPEATABLE GROUP)

━━━━━━━━━━━━━━━━━━━━

🟦 ADDITIONAL BACKGROUND

TRAVEL HISTORY

* Countries visited in the last 5 years

LANGUAGES

* Languages spoken

ORGANIZATIONS

* Have you belonged to, contributed to, or worked for any professional, social, or charitable organizations? YES/NO

  * IF NO:
    Organizations: N/A
  * IF YES:

    * Organization Name
    * Organization Type

(REPEATABLE GROUP)

SPECIALIZED SKILLS

* Do you possess specialized skills or training involving firearms, explosives, nuclear, biological, or chemical experience? YES/NO

  * IF NO:
    Specialized Skills: N/A
  * IF YES:

    * Full Description

━━━━━━━━━━━━━━━━━━━━

🟦 MILITARY SERVICE

* Have you served in the military? YES/NO

  * IF NO:
    Military Service Details: N/A
  * IF YES:

    * Country
    * Branch of Service
    * Rank / Position
    * Military Specialty
    * Service From
    * Service To

━━━━━━━━━━━━━━━━━━━━

🟦 SECURITY & BACKGROUND

For ALL questions below:

* ALWAYS output YES or NO
* IF YES → explanation required
* IF NO → write:
  Explanation: N/A

MEDICAL & HEALTH

* Communicable diseases
* Mental disorders posing danger
* Drug abuse or addiction

CRIMINAL

* Arrests or convictions
* Drug law violations
* Prostitution-related activities
* Money laundering

SECURITY

* Espionage
* Sabotage
* Export violations
* Terrorist activities
* Support to terrorist organizations
* Membership in terrorist organizations

HUMAN RIGHTS VIOLATIONS

* Genocide
* Torture
* Extrajudicial killings
* Religious freedom violations

IMMIGRATION VIOLATIONS

* Visa fraud
* Immigration fraud
* Visa overstays
* Deportation or removal
* Illegal voting in the United States
* Renouncing U.S. citizenship to avoid taxes

━━━━━━━━━━━━━━━━━━━━

🟦 APPLICATION PROCESSING

* Preferred Interview Language
* U.S. Embassy / Consulate Location
* Current Physical Location

━━━━━━━━━━━━━━━━━━━━
SUPPORTING DOCUMENT TRANSCRIPTIONS
━━━━━━━━━━━━━━━━━━━━

Whenever attachments exist:

ALWAYS include this exact section:

🟦 SUPPORTING DOCUMENT TRANSCRIPTIONS

For EACH uploaded file:

1. Document: <field name> — <original filename>

2. Transcription:

* Include ALL legible printed or handwritten content.
* Translate Hebrew into English.
* Preserve:

  * MRZ lines
  * passport numbers
  * visa numbers
  * document identifiers
  * dates
  * issuing authorities

3. Mapped to DS-160:

* Provide 3–10 bullets showing where the extracted information was used in the DS-160 sections.

If a specific element is unreadable:
❗ MISSING

Never say:

* “see attachment”
* “refer to uploaded file”

ALL relevant information must appear directly inside the generated document.

━━━━━━━━━━━━━━━━━━━━
ATTACHMENT-DRIVEN GAP FILLING
━━━━━━━━━━━━━━━━━━━━

Use uploads to fill missing fields whenever possible.

passportScan:

* primary source for identity data

existingVisaScan:

* primary source for PREVIOUS U.S. VISA fields
* extract: visa class, issue date, expiration date, visa number, entries
* if existingVisaScan is absent and hadUSVisa is "yes" → use N/A for sub-fields that cannot be determined

socialSecurityScan:

* extract SSN exactly if fully readable

americanLicenseScan:

* extract:

  * state
  * license number
  * expiration
  * class

extraDocumentScan1–3:

* transcribe
* map to DS-160 sections

Always merge extracted data into the main DS-160 structure first.

━━━━━━━━━━━━━━━━━━━━
STYLE RULES
━━━━━━━━━━━━━━━━━━━━

The output must be:

* professional
* structured
* complete
* deterministic
* human-review friendly
* DS-160 ordered

Never:

* omit fields
* omit sections
* output JSON
* use markdown tables
* use AI commentary
* hallucinate
* summarize away details

FINAL GOAL:

Generate a COMPLETE DS-160-style English review document that mirrors the structure of the real DS-160 form, fully populated from intake data and uploaded documents, ready for direct human verification before submission.
`
const USER_PREAMBLE =
  `Analyze the intake form data and all uploaded attachments below and generate a COMPLETE DS-160-style English review document following all system instructions exactly.

The output must:

* mirror the structure and ordering of the real DS-160
* include ALL sections and fields
* always answer YES/NO questions
* use NO when no evidence indicates YES
* use N/A for non-applicable conditional subsections
* use ❗ MISSING only for unavailable required factual information
* never omit fields or sections

If image or PDF attachments exist (including attachments loaded automatically by the system), the generated document MUST include the mandatory:

🟦 SUPPORTING DOCUMENT TRANSCRIPTIONS

section with:

* per-document transcriptions
* translated readable content
* DS-160 mapping bullets

Never tell the reviewer to open external files or attachments separately.

Use uploaded scans and documents to fill missing DS-160 fields whenever reliable information is visible, especially for:

* passport identity fields
* visa information
* SSN data
* driver license details
* travel history
* addresses
* employment or education information

Maintain this transcription order whenever applicable:

1. passportScan
2. existingVisaScan
3. socialSecurityScan
4. americanLicenseScan
5. extraDocumentScan1
6. extraDocumentScan2
7. extraDocumentScan3

A combined PDF will be generated automatically using:

* the DS-160 review document text
* followed by full-page embedded copies of uploaded files

Ensure the transcription blocks match the same document order used in the final PDF.
`

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
