import { useEffect, useRef, useState } from 'react'
import { getToken, setToken } from './lib/auth.js'
import { authHeaders } from './lib/auth.js'

const WARN_BEFORE_MS = 10 * 60 * 1000  // warn 10 min before expiry
const POLL_MS = 20_000

function getExpiry(token) {
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token.split('.')[0]))
    return typeof payload.e === 'number' ? payload.e : null
  } catch {
    return null
  }
}

/**
 * Silently polls token expiry.
 * - When < 10 min left: shows a small sticky banner with one "הארך סשן" button.
 * - When expired: shows a modal asking for password to re-login.
 * - On successful extend/re-login: replaces token, closes UI, user continues working.
 */
export default function SessionExpiryGuard({ onExpiredLogout }) {
  const [phase, setPhase] = useState('ok')      // 'ok' | 'warning' | 'expired'
  const [extending, setExtending] = useState(false)
  const [extendError, setExtendError] = useState('')
  const [password, setPassword] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const intervalRef = useRef(null)

  function tick() {
    const expiry = getExpiry(getToken())
    if (!expiry) { setPhase('expired'); return }
    const left = expiry - Date.now()
    if (left <= 0) setPhase('expired')
    else if (left <= WARN_BEFORE_MS) setPhase((p) => p === 'expired' ? 'expired' : 'warning')
    else setPhase((p) => p === 'expired' ? 'expired' : 'ok')
  }

  useEffect(() => {
    tick()
    intervalRef.current = setInterval(tick, POLL_MS)
    return () => clearInterval(intervalRef.current)
  }, [])

  async function handleExtend() {
    setExtending(true)
    setExtendError('')
    try {
      const res = await fetch('/api/guest-form?action=refresh', {
        method: 'POST',
        headers: { ...authHeaders() },
      })
      const json = await res.json()
      if (!res.ok) { setExtendError(json.error || 'שגיאה'); return }
      setToken(json.token)
      setPhase('ok')
      setSuccessMsg('הסשן הוארך ✓')
      setTimeout(() => setSuccessMsg(''), 3000)
    } catch (e) {
      setExtendError(e?.message || 'שגיאת רשת')
    } finally {
      setExtending(false)
    }
  }

  function getUserId() {
    try {
      const payload = JSON.parse(atob(getToken().split('.')[0]))
      return payload.u || ''
    } catch { return '' }
  }

  async function handleReLogin(e) {
    e.preventDefault()
    setLoginError('')
    setLoginLoading(true)
    try {
      const res = await fetch('/api/guest-form?action=login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: getUserId(), password }),
      })
      const json = await res.json()
      if (!res.ok) { setLoginError(json.error || 'שגיאת אימות'); return }
      setToken(json.token)
      setPassword('')
      setPhase('ok')
      setSuccessMsg('הסשן חודש ✓')
      setTimeout(() => setSuccessMsg(''), 3000)
    } catch (e) {
      setLoginError(e?.message || 'שגיאת רשת')
    } finally {
      setLoginLoading(false)
    }
  }

  // ── Success toast ──
  if (successMsg) {
    return (
      <div className="fixed bottom-4 right-4 z-50 bg-green-600 text-white text-sm px-4 py-2 rounded-lg shadow-lg" dir="rtl">
        {successMsg}
      </div>
    )
  }

  // ── Warning banner (session expiring soon) ──
  if (phase === 'warning') {
    return (
      <div className="fixed bottom-0 inset-x-0 z-50 flex justify-center pb-4 px-4" dir="rtl">
        <div className="bg-amber-50 border border-amber-300 rounded-xl shadow-xl px-5 py-3 flex items-center gap-4 max-w-lg w-full">
          <span className="text-2xl">⏳</span>
          <p className="flex-1 text-sm text-amber-900 font-medium">
            הסשן עומד לפוג בקרוב — לחץ להארכה כדי לא לאבד עבודה
          </p>
          {extendError && <span className="text-xs text-red-600">{extendError}</span>}
          <button
            onClick={handleExtend}
            disabled={extending}
            className="shrink-0 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition disabled:opacity-50"
          >
            {extending ? 'מאריך…' : 'הארך סשן'}
          </button>
        </div>
      </div>
    )
  }

  // ── Expired modal ──
  if (phase === 'expired') {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" dir="rtl">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
          <div className="bg-red-600 px-6 py-4 flex items-center gap-3">
            <span className="text-2xl">🔒</span>
            <div>
              <h2 className="text-white font-bold">הסשן פג תוקף</h2>
              <p className="text-white/80 text-sm">הנתונים שמורים — התחבר מחדש להמשך</p>
            </div>
          </div>
          <form onSubmit={handleReLogin} className="px-6 py-5 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">סיסמה</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loginLoading}
                autoFocus
                required
                autoComplete="current-password"
                placeholder="הכנס סיסמה"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-right focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              />
            </div>
            {loginError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{loginError}</p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={loginLoading || !password}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-2.5 rounded-lg transition disabled:opacity-50"
              >
                {loginLoading ? 'מתחבר…' : 'התחבר מחדש'}
              </button>
              <button
                type="button"
                onClick={onExpiredLogout}
                className="px-4 py-2.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition text-sm"
              >
                יציאה
              </button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  return null
}
