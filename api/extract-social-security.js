/**
 * POST /api/extract-social-security
 * Raw image body: Content-Type = image/* or application/pdf.
 * Configured OCR model → socialSecurityNumber (JSON).
 */

import { OPENAI_MODELS } from '../lib/openaiModels.js'

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
      'You are a social security card extraction assistant.\n\n' +
      'Your task is to analyze a Social Security card image and extract ONLY the Social Security Number (SSN).\n\n' +
      'Extraction rules:\n\n' +
      '* Use OCR and visual inspection\n' +
      '* Preserve the exact number formatting\n' +
      '* Do NOT guess digits\n' +
      '* If any digit is unclear, return null\n' +
      '* Ignore all other text on the card\n\n' +
      'Return ONLY valid JSON in this exact format (no markdown):\n\n' +
      '{\n' +
      '"socialSecurityNumber": ""\n' +
      '}\n\n' +
      'Use JSON null for socialSecurityNumber if the full SSN is not clearly readable.'

    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
    let openaiRes
    try {
      console.info(`[extract-social-security] OpenAI request model=${OPENAI_MODELS.ocr}`)
      openaiRes = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: OPENAI_MODELS.ocr,
          temperature: 0,
          max_completion_tokens: 200,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: promptText }, { type: 'image_url', image_url: { url: dataUrl, detail: 'original' } }],
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
      console.error('[extract-social-security] OpenAI error', openaiRes.status, rawText.slice(0, 500))
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

    const socialSecurityNumber = strOrEmpty(extracted.socialSecurityNumber)

    return jsonResponse(res, 200, { socialSecurityNumber })
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'OpenAI request timed out' : e?.message || 'extract-social-security error'
    console.error('[extract-social-security]', e)
    return jsonResponse(res, 500, { error: msg })
  }
}
