import { useEffect, useMemo, useState } from 'react'
import Fuse from 'fuse.js'
import { listFormBlobsFromApi, fetchFormBlobPayload, deleteFormFromCloud } from './lib/formBlob.js'
import { authHeaders } from './lib/auth.js'

export default function FormLanding({ onNewForm, onOpenForm, onLogout }) {
  const [forms, setForms] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deletingPathname, setDeletingPathname] = useState('')
  const [guestPanels, setGuestPanels] = useState({})
  /** 'incomplete' | 'completed' */
  const [activeTab, setActiveTab] = useState('incomplete')

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

  const completedForms = useMemo(() => filteredForms.filter((f) => f.isComplete === true), [filteredForms])
  const incompleteForms = useMemo(() => filteredForms.filter((f) => f.isComplete !== true), [filteredForms])

  // Auto-switch tab when search has results only in the other tab
  useEffect(() => {
    if (!searchQuery.trim()) return
    const hasInCurrent = activeTab === 'completed' ? completedForms.length > 0 : incompleteForms.length > 0
    const hasInOther = activeTab === 'completed' ? incompleteForms.length > 0 : completedForms.length > 0
    if (!hasInCurrent && hasInOther) {
      setActiveTab((t) => (t === 'completed' ? 'incomplete' : 'completed'))
    }
  }, [searchQuery, completedForms.length, incompleteForms.length, activeTab])

  // Reset to page 1 when tab or search changes
  useEffect(() => { setCurrentPage(1) }, [activeTab, searchQuery])

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

  const [currentPage, setCurrentPage] = useState(1)
  const PAGE_SIZE = 10

  const activeList = activeTab === 'completed' ? completedForms : incompleteForms
  const totalCompleted = forms.filter((f) => f.isComplete === true).length
  const totalIncomplete = forms.filter((f) => f.isComplete !== true).length

  const totalPages = Math.max(1, Math.ceil(activeList.length / PAGE_SIZE))
  const safePage = Math.min(currentPage, totalPages)
  const pagedList = activeList.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

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

          {/* Tabs */}
          <div className="flex border-b border-gray-200 mb-4">
            <button
              type="button"
              onClick={() => setActiveTab('incomplete')}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                activeTab === 'incomplete'
                  ? 'border-b-2 border-blue-600 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              🔴 לא הושלמו
              {!loading && (
                <span className="mr-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">
                  {searchQuery.trim() ? incompleteForms.length : totalIncomplete}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('completed')}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                activeTab === 'completed'
                  ? 'border-b-2 border-green-600 text-green-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              🟢 הושלמו
              {!loading && (
                <span className="mr-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">
                  {searchQuery.trim() ? completedForms.length : totalCompleted}
                </span>
              )}
            </button>
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
          {!loading && forms.length > 0 && activeList.length === 0 && (
            <p className="text-sm text-gray-500">
              {searchQuery.trim()
                ? 'לא נמצאו תוצאות לחיפוש בלשונית זו.'
                : activeTab === 'completed'
                  ? 'אין טפסים שהושלמו עדיין.'
                  : 'אין טפסים שלא הושלמו.'}
            </p>
          )}

          <ul className="space-y-3">
            {pagedList.map((f) => {
              const panel = guestPanels[f.pathname]
              const isCompleted = f.isComplete === true

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
                        {isCompleted ? (
                          <span title="טופס מלא">🟢</span>
                        ) : f.isComplete === false ? (
                          <span title={`חסרים ${f.missingCount ?? ''} שדות`}>🔴</span>
                        ) : (
                          <span title="סטטוס לא ידוע">🟡</span>
                        )}
                        {f.displayName}
                      </span>
                      <span className="text-xs text-gray-500 font-mono" dir="ltr">
                        {f.formId || '—'} · {f.uploadedAt ? new Date(f.uploadedAt).toLocaleString('he-IL') : ''}
                      </span>
                      {isCompleted && f.completedAt && (
                        <span className="text-xs text-green-700 font-medium mt-0.5">
                          ✓ הועבר ל-Monday:{' '}
                          <span dir="ltr">{new Date(f.completedAt).toLocaleString('he-IL')}</span>
                        </span>
                      )}
                      {!isCompleted && f.isComplete === false && (
                        <span className="text-xs text-red-600 mt-0.5">
                          חסרים {f.missingCount ?? '?'} שדות
                        </span>
                      )}
                    </button>

                    {!isCompleted && (
                      <button
                        type="button"
                        disabled={!!deletingPathname || panel?.loading}
                        onClick={() => void handleGenerateGuestLink(f)}
                        title={f.isComplete === false ? `צור קישור אישי ללקוח למילוי ${f.missingCount ?? '?'} שדות חסרים` : 'צור קישור אישי ללקוח למילוי שדות חסרים'}
                        className="shrink-0 px-3 py-2 rounded-md border border-blue-200 text-blue-700 text-sm font-medium hover:bg-blue-50 disabled:opacity-40 flex flex-col items-center leading-tight"
                      >
                        <span>{panel?.loading ? '…' : '📤'}</span>
                        <span className="text-[10px] font-normal">קישור ללקוח</span>
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

                  {panel && (
                    <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm space-y-1.5">
                      {panel.error && (
                        <p className="text-red-600">{panel.error}</p>
                      )}
                      {panel.guestLink && (
                        <>
                          <p className="text-xs text-blue-800 font-medium">
                            קישור אישי ללקוח למילוי שדות חסרים — שלח ב-WhatsApp או במייל:
                          </p>
                          <div className="flex items-center gap-2">
                            <span className="text-gray-600 text-xs truncate flex-1 font-mono bg-white border border-blue-200 rounded px-2 py-1" dir="ltr">
                              {panel.guestLink}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleCopyLink(panel.guestLink)}
                              className="shrink-0 px-2 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 font-medium"
                            >
                              העתק
                            </button>
                          </div>
                          <p className="text-[11px] text-blue-700">
                            הלקוח ימלא רק את השדות החסרים. לאחר שישלח, הטופס יתעדכן אוטומטית.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
                className="px-3 py-1.5 text-sm rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← הקודם
              </button>
              <span className="text-sm text-gray-500">
                עמוד {safePage} מתוך {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                className="px-3 py-1.5 text-sm rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                הבא →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
