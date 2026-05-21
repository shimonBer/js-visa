/**
 * POST /api/auth
 * Validates credentials against the Supabase `users` table.
 * Returns a signed session token (lightweight JWT-style).
 */
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

/** PBKDF2 verify: stored format is "iterations:salt_hex:hash_hex" */
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

/** Build a signed token: base64(payload).hmac */
function buildToken(userId, isAdmin) {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET not configured')
  const exp = Date.now() + 8 * 60 * 60 * 1000 // 8 hours
  const payload = Buffer.from(JSON.stringify({ u: userId, a: isAdmin, e: exp })).toString('base64')
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64')
  return `${payload}.${sig}`
}

async function readBody(req) {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { userId, password } = await readBody(req)

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

    const token = buildToken(user.user_id, user.is_admin)
    return res.status(200).json({ token, isAdmin: user.is_admin })
  } catch (e) {
    console.error('[auth]', e)
    return res.status(500).json({ error: e?.message || 'Auth error' })
  }
}
