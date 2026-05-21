import { useState } from 'react'
import { setToken } from './lib/auth.js'

export default function LoginPage({ onLogin }) {
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId.trim(), password }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'שגיאת התחברות')
        return
      }
      setToken(json.token)
      onLogin()
    } catch (e) {
      setError(e?.message || 'שגיאת רשת')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gray-100 flex items-center justify-center px-4 font-sans">
      <div className="w-full max-w-sm bg-white shadow-xl rounded-xl p-8 space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">כניסה למערכת</h1>
          <p className="mt-1 text-sm text-gray-500">DS-160 ניהול טפסי</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="userId" className="block text-sm font-medium text-gray-700 mb-1">
              שם משתמש
            </label>
            <input
              id="userId"
              type="text"
              autoComplete="username"
              required
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={loading}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-right focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              placeholder="user_id"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              סיסמה
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-right focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 transition disabled:opacity-50"
          >
            {loading ? 'מתחבר…' : 'כניסה'}
          </button>
        </form>
      </div>
    </div>
  )
}
