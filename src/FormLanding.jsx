import { useEffect, useMemo, useState } from 'react'
import Fuse from 'fuse.js'
import { listFormBlobsFromApi, fetchFormBlobPayload, deleteFormFromCloud } from './lib/formBlob.js'
import { authHeaders } from './lib/auth.js'

export default function FormLanding({ onNewForm, onOpenForm, onLogout }) {
  const [forms, setForms] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** Non-blocking message after delete (e.g. some S3 keys failed). */
  const [notice, setNotice] = useState('')
  /** pathname currently being deleted (disables actions for that row). */
  const [deletingPathname, setDeletingPathname] = useState('')
  /** Map of pathname → { guestLink, loading, error } for the copy-link panel. */
  const [guestPanels, setGuestPanels] = useState({})

  const filteredForms = useMemo(() => {
    const q = searchQuery.trim()
    if (!q) return forms
    const fuse = new Fuse(forms, {
      keys: ['displayName'],
      threshold: 0.4,
      ignoreLocation: true,
    })
    return fuse.search(q).map((r) => r.item)
  }, [forms, searchQuery])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const data = await listFormBlobsFromApi()
        if (!cancelled && data.forms) setForms(data.forms)
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || 'לא ניתן לטעון רשימת טפסים')
          setForms([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleContinue(pathname) {
    setError('')
    setNotice('')
    try {
      const { payload } = await fetchFormBlobPayload(pathname)
      onOpenForm(pathname, payload)
    } catch (e) {
      setError(e?.message || 'טעינת הטופס נכשלה')
    }
  }

  async function handleDeleteForm(f) {
    const label = f.displayName || f.pathname
    if (!window.confirm(`למחוק לצמיתות את "${label}" מהענן (Vercel Blob) וקבצים ב-S3?`)) {
      return
    }
    setError('')
    setNotice('')
    setDeletingPathname(f.pathname)
    try {
      const result = await deleteFormFromCloud(f.pathname)
      setForms((prev) => prev.filter((x) => x.pathname !== f.pathname))
      if (Array.isArray(result.s3Errors) && result.s3Errors.length > 0) {
        setNotice(
          `הטופס נמחק מ-Vercel Blob. לא נמחקו ${result.s3Errors.length} קבצים מ-S3 (בדוק הרשאות או מפתחות).`,
        )
      }
    } catch (e) {
      setError(e?.message || 'מחיקה נכשלה')
    } finally {
      setDeletingPathname('')
    }
  }

  async function handleGenerateGuestLink(f) {
    setGuestPanels((prev) => ({
      ...prev,
      [f.pathname]: { loading: true, guestLink: '', error: '' },
    }))
    try {
      const res = await fetch('/api/guest-form?action=generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ pathname: f.pathname }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'שגיאה')
      setGuestPanels((prev) => ({
        ...prev,
        [f.pathname]: { loading: false, guestLink: json.guestLink, error: '' },
      }))
      // Update the form entry with the new guestToken so the button shows the existing link
      setForms((prev) =>
        prev.map((x) =>
          x.pathname === f.pathname ? { ...x, guestToken: json.guestToken } : x,
        ),
      )
    } catch (e) {
      setGuestPanels((prev) => ({
        ...prev,
        [f.pathname]: { loading: false, guestLink: '', error: e?.message || 'שגיאה' },
      }))
    }
  }

  async function handleCopyLink(link) {
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      window.prompt('העתק את הקישור:', link)
    }
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gray-100 py-12 px-4 font-sans text-right">
      <div className="max-w-lg mx-auto bg-white shadow-xl rounded-xl overflow-hidden p-8 space-y-8">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">טפסי DS-160</h1>
            <p className="mt-2 text-gray-600 text-sm">
              התחל טופס חדש או המשך טופס שמור בענן (Vercel Blob).
            </p>
          </div>
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="shrink-0 text-xs text-gray-500 hover:text-gray-800 underline mt-1"
            >
              יציאה
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onNewForm}
          className="w-full py-3 px-4 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 transition"
        >
          מלא טופס חדש
        </button>

        <div className="border-t border-gray-200 pt-6">
          <h2 className="font-semibold text-gray-800 mb-3">המשך טופס קיים</h2>
          <div className="mb-4">
            <label htmlFor="form-search" className="block text-sm font-medium text-gray-700 mb-1">
              חיפוש לפי שם (שם פרטי + משפחה)
            </label>
            <input
              id="form-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="הקלד שם…"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-right focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              disabled={loading}
            />
          </div>
          {loading && <p className="text-sm text-gray-500">טוען רשימה…</p>}
          {error && (
            <p className="text-sm text-red-600 mb-3" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3" role="status">
              {notice}
            </p>
          )}
          {!loading && forms.length === 0 && !error && (
            <p className="text-sm text-gray-500">אין טפסים שמורים בענן עדיין.</p>
          )}
          {!loading && forms.length > 0 && filteredForms.length === 0 && searchQuery.trim() && (
            <p className="text-sm text-gray-500 mb-2">לא נמצאו תוצאות לחיפוש.</p>
          )}
          <ul className="space-y-3">
            {filteredForms.map((f) => {
              const panel = guestPanels[f.pathname]
              const statusDot =
                f.isComplete === true
                  ? { symbol: '🟢', title: 'טופס מלא' }
                  : f.isComplete === false
                    ? { symbol: '🔴', title: `חסרים ${f.missingCount ?? ''} שדות` }
                    : { symbol: '🟡', title: 'סטטוס לא ידוע — פתח ושמור טיוטה כדי לרענן' }

              return (
                <li key={f.pathname} className="space-y-1">
                  <div className="flex gap-2 items-stretch">
                    <button
                      type="button"
                      disabled={!!deletingPathname}
                      onClick={() => void handleContinue(f.pathname)}
                      className="min-w-0 flex-1 text-right py-2 px-3 rounded-md border border-gray-200 hover:bg-gray-50 flex flex-col gap-0.5 disabled:opacity-40"
                    >
                      <span className="font-medium text-gray-900 flex items-center gap-1.5">
                        {statusDot && (
                          <span title={statusDot.title}>{statusDot.symbol}</span>
                        )}
                        {f.displayName}
                      </span>
                      <span className="text-xs text-gray-500 font-mono" dir="ltr">
                        {f.formId || '—'} · {f.uploadedAt ? new Date(f.uploadedAt).toLocaleString('he-IL') : ''}
                      </span>
                    </button>

                    {/* Send-to-client button — for incomplete or unknown-status forms */}
                    {f.isComplete !== true && (
                      <button
                        type="button"
                        disabled={!!deletingPathname || panel?.loading}
                        onClick={() => void handleGenerateGuestLink(f)}
                        title={f.isComplete === false ? `שלח ללקוח לימלא שדות חסרים (${f.missingCount ?? '?'} שדות)` : 'שלח ללקוח לימלא שדות חסרים'}
                        className="shrink-0 px-3 py-2 rounded-md border border-blue-200 text-blue-700 text-sm font-medium hover:bg-blue-50 disabled:opacity-40"
                      >
                        {panel?.loading ? '…' : '📤'}
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={!!deletingPathname}
                      onClick={() => void handleDeleteForm(f)}
                      className="shrink-0 px-3 py-2 rounded-md border border-red-200 text-red-700 text-sm font-medium hover:bg-red-50 disabled:opacity-40"
                      aria-label={`מחק ${f.displayName}`}
                    >
                      {deletingPathname === f.pathname ? '…' : 'מחק'}
                    </button>
                  </div>

                  {/* Copy-link panel */}
                  {panel && (
                    <div className="rounded-md border px-3 py-2 text-sm">
                      {panel.error && (
                        <p className="text-red-600">{panel.error}</p>
                      )}
                      {panel.guestLink && (
                        <div className="flex items-center gap-2">
                          <span className="text-gray-600 text-xs truncate flex-1" dir="ltr">
                            {panel.guestLink}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleCopyLink(panel.guestLink)}
                            className="shrink-0 px-2 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700"
                          >
                            העתק קישור
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
