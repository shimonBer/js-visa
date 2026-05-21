/**
 * Client-side auth helpers.
 * Token is stored in sessionStorage so it clears when the browser tab closes.
 * Format: <base64-payload>.<hmac-signature>
 * Payload: { u: userId, a: isAdmin, e: expiryEpochMs }
 */

const TOKEN_KEY = 'ds160_auth_token'

export function setToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    // ignore (private browsing restrictions)
  }
}

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // ignore
  }
}

/** Decode the payload portion of the token without verifying the signature. */
function decodePayload(token) {
  if (!token) return null
  try {
    const [payloadB64] = token.split('.')
    return JSON.parse(atob(payloadB64))
  } catch {
    return null
  }
}

/** Returns true if a valid, non-expired token exists in sessionStorage. */
export function isAuthenticated() {
  const token = getToken()
  if (!token) return false
  const payload = decodePayload(token)
  if (!payload || typeof payload.e !== 'number') return false
  return Date.now() < payload.e
}

/** Returns true if the token carries an isAdmin=true claim. */
export function isAdmin() {
  const payload = decodePayload(getToken())
  return !!payload?.a
}

/** Returns the Authorization header object for admin API calls. */
export function authHeaders() {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
