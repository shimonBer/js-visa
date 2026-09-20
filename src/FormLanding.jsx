import { useEffect, useMemo, useState } from 'react'
import Fuse from 'fuse.js'
import { listFormBlobsFromApi, fetchFormBlobPayload, deleteFormFromCloud } from './lib/formBlob.js'
import { authHeaders } from './lib/auth.js'

export default function FormLanding({
  onNewForm,
  onOpenForm,
  onLogout,
  selectedPathname = null,
  onCanLeave,
}) {
  const [forms, setForms] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deletingPathname, setDeletingPathname] = useState('')
  const [guestPanels, setGuestPanels] = useState({})
  const [currentPage, setCurrentPage] = useState(1)
  const [openingPathname, setOpeningPathname] = useState('')
  const PAGE_SIZE = 12

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

  useEffect(() => { setCurrentPage(1) }, [searchQuery])

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
    if (pathname === selectedPathname) return
    if (typeof onCanLeave === 'function' && !onCanLeave()) return
    setError('')
    setNotice('')
    setOpeningPathname(pathname)
    try {
      const { payload } = await fetchFormBlobPayload(pathname)
      onOpenForm(pathname, payload)
    } catch (e) {
      setError(e?.message || 'טעינת הטופס נכשלה')
    } finally {
      setOpeningPathname('')
    }
  }

  function handleNewForm() {
    if (typeof onCanLeave === 'function' && !onCanLeave()) return
    onNewForm()
  }

  async function handleDeleteForm(f) {
    const label = f.displayName || f.pathname
    if (!window.confirm(`למחוק לצמיתות את "${label}"?`)) {
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
          `הטופס נמחק. לא נמחקו ${result.s3Errors.length} קבצי סריקה (בדוק הרשאות).`,
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

  const totalPages = Math.max(1, Math.ceil(filteredForms.length / PAGE_SIZE))
  const safePage = Math.min(currentPage, totalPages)
  const pagedList = filteredForms.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const busy = !!deletingPathname || !!openingPathname

  return (
    <div dir="rtl" className="flex h-full min-h-0 flex-col bg-white font-sans text-right">
      <div className="shrink-0 space-y-3 border-b border-gray-200 p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold text-gray-900">טפסי DS-160</h1>
            <p className="mt-1 text-xs text-gray-500">
              כל הטפסים. לחיצה פותחת את הטופס בצד השני.
            </p>
          </div>
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="mt-0.5 shrink-0 text-xs text-gray-500 underline hover:text-gray-800"
            >
              יציאה
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={handleNewForm}
          disabled={busy}
          className="w-full rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
        >
          מלא טופס חדש
        </button>

        <div>
          <label htmlFor="form-search" className="mb-1 block text-sm font-medium text-gray-700">
            חיפוש לפי שם
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && <p className="text-sm text-gray-500">טוען רשימה…</p>}
        {error && (
          <p className="mb-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
            {notice}
          </p>
        )}
        {!loading && forms.length === 0 && !error && (
          <p className="text-sm text-gray-500">אין טפסים שמורים עדיין.</p>
        )}
        {!loading && forms.length > 0 && filteredForms.length === 0 && (
          <p className="text-sm text-gray-500">לא נמצאו תוצאות לחיפוש.</p>
        )}

        <ul className="space-y-2">
          {pagedList.map((f) => {
            const panel = guestPanels[f.pathname]
            const isCompleted = f.isComplete === true
            const selected = f.pathname === selectedPathname
            const opening = openingPathname === f.pathname

            return (
              <li key={f.pathname} className="space-y-1">
                <div className="flex items-stretch gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleContinue(f.pathname)}
                    className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border px-2.5 py-2 text-right disabled:opacity-40 ${
                      selected
                        ? 'border-blue-400 bg-blue-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 font-medium text-gray-900">
                      {isCompleted ? (
                        <span title="טופס מלא">🟢</span>
                      ) : f.isComplete === false ? (
                        <span title={`חסרים ${f.missingCount ?? ''} שדות`}>🔴</span>
                      ) : (
                        <span title="סטטוס לא ידוע">🟡</span>
                      )}
                      {f.ds160FilledAt && (
                        <span title="DS-160 מולא אוטומטית">📄</span>
                      )}
                      <span className="truncate">{f.displayName}</span>
                    </span>
                    <span className="font-mono text-[11px] text-gray-500" dir="ltr">
                      {opening ? 'טוען…' : (f.formId || '—')}
                    </span>
                    {isCompleted && f.completedAt && (
                      <span className="text-[11px] font-medium text-green-700">
                        ✓ הושלם
                      </span>
                    )}
                    {f.mondaySentAt && (
                      <span className="text-[11px] font-medium text-blue-700">
                        ✓ Monday
                      </span>
                    )}
                    {f.ds160FilledAt && (
                      <span className="text-[11px] font-medium text-teal-700">
                        ✓ DS-160 מולא
                      </span>
                    )}
                    {!isCompleted && f.isComplete === false && (
                      <span className="text-[11px] text-red-600">
                        חסרים {f.missingCount ?? '?'} שדות
                      </span>
                    )}
                  </button>

                  {!isCompleted && (
                    <button
                      type="button"
                      disabled={busy || panel?.loading}
                      onClick={() => void handleGenerateGuestLink(f)}
                      title="צור קישור אישי ללקוח"
                      className="flex shrink-0 flex-col items-center justify-center rounded-md border border-blue-200 px-2 py-1 text-blue-700 hover:bg-blue-50 disabled:opacity-40"
                    >
                      <span className="text-sm">{panel?.loading ? '…' : '📤'}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDeleteForm(f)}
                    className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
                    aria-label={`מחק ${f.displayName}`}
                  >
                    {deletingPathname === f.pathname ? '…' : 'מחק'}
                  </button>
                </div>

                {panel && (
                  <div className="space-y-1.5 rounded-md border border-blue-100 bg-blue-50 px-2.5 py-2 text-sm">
                    {panel.error && (
                      <p className="text-red-600">{panel.error}</p>
                    )}
                    {panel.guestLink && (
                      <>
                        <p className="text-xs font-medium text-blue-800">
                          קישור אישי ללקוח:
                        </p>
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate rounded border border-blue-200 bg-white px-2 py-1 font-mono text-xs text-gray-600" dir="ltr">
                            {panel.guestLink}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleCopyLink(panel.guestLink)}
                            className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                          >
                            העתק
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-between border-t border-gray-100 px-3 py-2">
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={safePage === 1}
            className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← הקודם
          </button>
          <span className="text-xs text-gray-500">
            {safePage} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            הבא →
          </button>
        </div>
      )}
    </div>
  )
}
