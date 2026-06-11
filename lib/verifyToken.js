/**
 * Server-side token verification.
 * Mirrors the client-side logic in src/lib/auth.js but also checks the HMAC signature.
 */
import crypto from 'crypto'

/**
 * Verify the Bearer token from the Authorization header.
 * @param {import('http').IncomingMessage} req
 * @returns {{ ok: true, userId: string, isAdmin: boolean } | { ok: false, status: number, error: string }}
 */
export function verifyRequest(req) {
  const secret = process.env.JWT_SECRET
  if (!secret) return { ok: false, status: 503, error: 'JWT_SECRET not configured' }

  const auth = req.headers?.authorization || ''
  if (!auth.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Authentication required' }
  }

  const token = auth.slice(7)
  const dotIdx = token.lastIndexOf('.')
  if (dotIdx < 1) return { ok: false, status: 401, error: 'Invalid token' }

  const payloadB64 = token.slice(0, dotIdx)
  const sig = token.slice(dotIdx + 1)
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64')

  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return { ok: false, status: 401, error: 'Invalid token signature' }
    }
  } catch {
    return { ok: false, status: 401, error: 'Invalid token' }
  }

  let payload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'))
  } catch {
    return { ok: false, status: 401, error: 'Invalid token payload' }
  }

  if (typeof payload.e !== 'number' || Date.now() >= payload.e) {
    return { ok: false, status: 401, error: 'Token expired' }
  }

  return { ok: true, userId: payload.u, isAdmin: !!payload.a }
}
