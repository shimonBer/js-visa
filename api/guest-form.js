/**
 * /api/guest-form
 *
 * POST ?action=login  (public)
 *   Body: { userId, password }
 *   → Validates against Supabase users table, returns { token, isAdmin }
 *
 * POST ?action=generate  (admin token required)
 *   Body: { pathname: string }
 *   → Adds a guestToken to the blob, updates the status index, returns { guestLink, guestToken }
 *
 * GET ?token=<guestToken>  (public)
 *   → Returns { formContext: { name }, missingFields: [{field, label, type, options?}] }
 *
 * PATCH ?token=<guestToken>  (public)
 *   Body: { answers: { [field]: value } }
 *   → Merges only the allowed missing fields into the blob, saves it back
 */
import crypto from 'crypto'
import { put, list, get } from '@vercel/blob'
import { createClient } from '@supabase/supabase-js'
import { verifyRequest } from './lib/verifyToken.js'
import { calculateCompleteness } from '../src/lib/formCompleteness.js'

// ── Auth helpers (formerly api/auth.js) ──────────────────────────────────────

function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

function verifyPassword(plaintext, stored) {
  try {
    const [iterStr, salt, expected] = stored.split(':')
    const iterations = parseInt(iterStr, 10)
    const actual = crypto.pbkdf2Sync(plaintext, salt, iterations, 64, 'sha512').toString('hex')
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

function buildToken(userId, isAdmin) {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET not configured')
  const exp = Date.now() + 8 * 60 * 60 * 1000
  const payload = Buffer.from(JSON.stringify({ u: userId, a: isAdmin, e: exp })).toString('base64')
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64')
  return `${payload}.${sig}`
}

const PREFIX = 'forms/'
const STATUS_PATH = 'forms-meta/status.json'

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN
}

async function readBodyJson(req) {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

async function streamToUtf8(stream) {
  const buf = await new Response(stream).arrayBuffer()
  return Buffer.from(buf).toString('utf8')
}

async function readStatusIndex(token) {
  try {
    const result = await get(STATUS_PATH, { access: 'private', token })
    if (!result || result.statusCode !== 200 || !result.stream) return {}
    return JSON.parse(await streamToUtf8(result.stream))
  } catch {
    return {}
  }
}

async function writeStatusIndex(token, index) {
  try {
    await put(STATUS_PATH, JSON.stringify(index), {
      access: 'private',
      token,
      contentType: 'application/json',
      allowOverwrite: true,
    })
  } catch (e) {
    console.warn('[guest-form] status index write failed:', e?.message)
  }
}

async function readBlob(pathname, token) {
  const result = await get(pathname, { access: 'private', token })
  if (!result || result.statusCode !== 200 || !result.stream) return null
  return JSON.parse(await streamToUtf8(result.stream))
}

/** Find the blob pathname for a given guestToken by scanning the status index. */
async function findPathnameByToken(guestToken, token) {
  const index = await readStatusIndex(token)
  for (const [pathname, entry] of Object.entries(index)) {
    if (entry.guestToken === guestToken) return { pathname, entry }
  }
  // Fallback: scan all blobs (handles legacy entries without index)
  let cursor
  let hasMore = true
  while (hasMore) {
    const page = await list({ prefix: PREFIX, token, cursor, limit: 1000 })
    for (const b of page.blobs) {
      try {
        const payload = await readBlob(b.pathname, token)
        if (payload?.guestToken === guestToken) return { pathname: b.pathname, entry: {} }
      } catch {
        // skip
      }
    }
    hasMore = page.hasMore
    cursor = page.cursor
  }
  return null
}

/** @param {import('http').IncomingMessage} req */
export default async function handler(req, res) {
  const token = blobToken()
  if (!token) return res.status(503).json({ error: 'Blob not configured' })

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const action = url.searchParams.get('action')
  const guestToken = url.searchParams.get('token')

  try {
    // ── POST ?action=login ────────────────────────────────────────────────
    if (req.method === 'POST' && action === 'login') {
      const body = await readBodyJson(req)
      const { userId, password } = body
      if (!userId || !password) {
        return res.status(400).json({ error: 'Missing userId or password' })
      }
      const db = supabase()
      const { data: user, error } = await db
        .from('users')
        .select('user_id, password_hash, is_admin')
        .eq('user_id', String(userId).trim())
        .single()
      if (error || !user) {
        return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' })
      }
      if (!verifyPassword(String(password), user.password_hash)) {
        return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' })
      }
      const sessionToken = buildToken(user.user_id, user.is_admin)
      return res.status(200).json({ token: sessionToken, isAdmin: user.is_admin })
    }

    // ── POST ?action=generate ─────────────────────────────────────────────
    if (req.method === 'POST' && action === 'generate') {
      const auth = verifyRequest(req)
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

      const body = await readBodyJson(req)
      const pathname =
        typeof body.pathname === 'string' && body.pathname.startsWith('forms/') ? body.pathname : null
      if (!pathname) return res.status(400).json({ error: 'Invalid pathname' })

      const payload = await readBlob(pathname, token)
      if (!payload) return res.status(404).json({ error: 'Form not found' })

      // Re-use existing token or generate new one
      const existingToken = payload.guestToken || null
      const newToken = existingToken || crypto.randomUUID()

      // Store the original list of invited fields so the client can see already-filled ones on return
      const formData = payload?.data && typeof payload.data === 'object' ? payload.data : {}
      const { missingFields: currentMissing } = calculateCompleteness(formData)
      // Preserve existing guestFields if re-generating for the same form
      const guestFields = payload.guestFields && payload.guestFields.length > 0
        ? payload.guestFields
        : currentMissing

      const enriched = { ...payload, guestToken: newToken, guestFields }
      await put(pathname, JSON.stringify(enriched), {
        access: 'private',
        token,
        contentType: 'application/json',
        allowOverwrite: true,
      })

      const statusIndex = await readStatusIndex(token)
      statusIndex[pathname] = {
        ...(statusIndex[pathname] || {}),
        guestToken: newToken,
      }
      await writeStatusIndex(token, statusIndex)

      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : url.origin
      const guestLink = `${baseUrl}/fill/${newToken}`

      return res.status(200).json({ guestLink, guestToken: newToken })
    }

    // ── GET ?token=xxx ────────────────────────────────────────────────────
    if (req.method === 'GET' && guestToken) {
      const found = await findPathnameByToken(guestToken, token)
      if (!found) return res.status(404).json({ error: 'קישור לא תקף או שפג תוקפו' })

      const payload = await readBlob(found.pathname, token)
      if (!payload) return res.status(404).json({ error: 'הטופס לא נמצא' })

      const formData = payload?.data && typeof payload.data === 'object' ? payload.data : {}
      const name = [formData.firstName, formData.lastName].filter(Boolean).join(' ')

      // Use the stored original invited fields so returning clients see what they already filled.
      // Fall back to current missing fields for older tokens that predate guestFields storage.
      const { missingFields: currentMissing } = calculateCompleteness(formData)
      const baseFields = Array.isArray(payload.guestFields) && payload.guestFields.length > 0
        ? payload.guestFields
        : currentMissing

      // Annotate each field with its current saved value and whether it's already filled
      const missingFieldKeys = new Set(currentMissing.map((f) => f.field))
      const guestFields = baseFields.map((f) => {
        const rawVal = formData[f.field]
        const isFilled = !missingFieldKeys.has(f.field)
        const currentValue = rawVal != null ? rawVal : ''
        return { ...f, currentValue, isFilled }
      })

      return res.status(200).json({
        formContext: { name: name || 'לקוח' },
        missingFields: currentMissing,
        guestFields,
      })
    }

    // ── PATCH ?token=xxx ──────────────────────────────────────────────────
    if (req.method === 'PATCH' && guestToken) {
      const found = await findPathnameByToken(guestToken, token)
      if (!found) return res.status(404).json({ error: 'קישור לא תקף' })

      const payload = await readBlob(found.pathname, token)
      if (!payload) return res.status(404).json({ error: 'הטופס לא נמצא' })

      const body = await readBodyJson(req)
      const answers = body?.answers && typeof body.answers === 'object' ? body.answers : {}

      const formData = payload?.data && typeof payload.data === 'object' ? payload.data : {}

      // Whitelist: only allow fields that were actually missing
      const { missingFields } = calculateCompleteness(formData)
      const allowedFields = new Set(missingFields.map((f) => f.field))

      const mergedData = { ...formData }
      for (const [field, value] of Object.entries(answers)) {
        if (allowedFields.has(field)) {
          mergedData[field] = value
        }
      }

      const newCompleteness = calculateCompleteness(mergedData)
      const updatedPayload = {
        ...payload,
        data: { ...payload.data, ...mergedData },
        completeness: newCompleteness,
        // Remove guestToken if form is now complete
        ...(newCompleteness.isComplete ? { guestToken: null } : {}),
      }

      await put(found.pathname, JSON.stringify(updatedPayload), {
        access: 'private',
        token,
        contentType: 'application/json',
        allowOverwrite: true,
      })

      // Update status index
      const statusIndex = await readStatusIndex(token)
      statusIndex[found.pathname] = {
        ...(statusIndex[found.pathname] || {}),
        isComplete: newCompleteness.isComplete,
        missingCount: newCompleteness.missingFields.length,
        guestToken: newCompleteness.isComplete ? null : guestToken,
      }
      await writeStatusIndex(token, statusIndex)

      return res.status(200).json({
        ok: true,
        isComplete: newCompleteness.isComplete,
        remainingMissing: newCompleteness.missingFields.length,
      })
    }

    res.setHeader('Allow', 'GET, POST, PATCH')
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    console.error('[guest-form]', e)
    return res.status(500).json({ error: e?.message || 'שגיאת שרת' })
  }
}
