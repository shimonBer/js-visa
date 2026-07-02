/**
 * POST /api/browser-use — I-94 travel history via local Playwright
 *
 * Two fast actions so the Vercel Hobby 10-second timeout is never breached.
 * The client drives the polling loop (see src/lib/browserUse.js).
 *
 * action = "create"
 *   Body: { action, firstName, lastName, birthDate, passportNumber, country }
 *   Spawns autofill/fetch-i94.js as a detached background process.
 *   Returns: { pending: true, sessionId }
 *
 * action = "poll"
 *   Body: { action, sessionId }
 *   Checks /tmp/i94-{sessionId}.json written by the Playwright script.
 *   Returns: { pending: true }  — still running
 *         or { pending: false, success, history[] }  — done
 */

import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function jsonResponse(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** @param {import('http').IncomingMessage} req */
async function readBodyJson(req) {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new Error('Invalid JSON body') }
}

/** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return jsonResponse(res, 405, { error: 'Method not allowed' })
  }

  if (process.env.I94_ENABLED === 'false') {
    return jsonResponse(res, 503, { error: 'I-94 lookup is disabled', code: 'I94_DISABLED' })
  }

  let body
  try { body = await readBodyJson(req) } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON body' })
  }

  const action = String(body?.action ?? 'create')
  const scriptPath = join(__dirname, '../autofill/fetch-i94.js')

  if (!existsSync(scriptPath)) {
    return jsonResponse(res, 503, { error: 'fetch-i94.js not found — run in local dev', code: 'LOCAL_ONLY' })
  }

  // ── action = "create" ──────────────────────────────────────────────────────
  if (action === 'create') {
    const firstName    = String(body?.firstName    ?? '').trim()
    const lastName     = String(body?.lastName     ?? '').trim()
    const birthDate    = String(body?.birthDate    ?? '').trim()
    const passportNumber = String(body?.passportNumber ?? '').trim()
    const country      = String(body?.country      ?? '').trim()

    if (!firstName || !lastName || !birthDate || !passportNumber || !country) {
      return jsonResponse(res, 400, {
        error: 'Missing required fields: firstName, lastName, birthDate, passportNumber, country',
      })
    }

    const sessionId  = randomBytes(8).toString('hex')
    const outputPath = `/tmp/i94-${sessionId}.json`

    console.log('[i94] spawning Playwright script', { sessionId, firstName, lastName })

    const child = spawn(
      process.execPath,
      [
        scriptPath,
        '--firstName',  firstName,
        '--lastName',   lastName,
        '--birthDate',  birthDate,
        '--passport',   passportNumber,
        '--country',    country,
        '--headless',
        '--output',     outputPath,
      ],
      {
        detached: true,
        stdio:    'ignore',
        env:      { ...process.env },
      },
    )
    child.unref()

    return jsonResponse(res, 200, { pending: true, sessionId })
  }

  // ── action = "poll" ────────────────────────────────────────────────────────
  if (action === 'poll') {
    const sessionId = String(body?.sessionId ?? '').trim()
    if (!sessionId) return jsonResponse(res, 400, { error: 'Missing sessionId' })

    const outputPath = `/tmp/i94-${sessionId}.json`

    if (!existsSync(outputPath)) {
      return jsonResponse(res, 200, { pending: true, sessionId })
    }

    try {
      const result = JSON.parse(readFileSync(outputPath, 'utf8'))
      console.log('[i94] result ready', { sessionId, success: result.success, entries: result.history?.length })
      return jsonResponse(res, 200, { pending: false, ...result })
    } catch (e) {
      return jsonResponse(res, 500, { error: `Could not read result: ${e?.message}` })
    }
  }

  return jsonResponse(res, 400, { error: `Unknown action: "${action}"` })
}
