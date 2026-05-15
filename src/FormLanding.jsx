import { useEffect, useMemo, useState } from 'react'
import Fuse from 'fuse.js'
import { listFormBlobsFromApi, fetchFormBlobPayload } from './lib/formBlob.js'

export default function FormLanding({ onNewForm, onOpenForm }) {
  const [forms, setForms] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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
    try {
      const { payload } = await fetchFormBlobPayload(pathname)
      onOpenForm(pathname, payload)
    } catch (e) {
      setError(e?.message || 'טעינת הטופס נכשלה')
    }
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gray-100 py-12 px-4 font-sans text-right">
      <div className="max-w-lg mx-auto bg-white shadow-xl rounded-xl overflow-hidden p-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">טפסי DS-160</h1>
          <p className="mt-2 text-gray-600 text-sm">
            התחל טופס חדש או המשך טופס שמור בענן (Vercel Blob).
          </p>
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
          {!loading && forms.length === 0 && !error && (
            <p className="text-sm text-gray-500">אין טפסים שמורים בענן עדיין.</p>
          )}
          {!loading && forms.length > 0 && filteredForms.length === 0 && searchQuery.trim() && (
            <p className="text-sm text-gray-500 mb-2">לא נמצאו תוצאות לחיפוש.</p>
          )}
          <ul className="space-y-2">
            {filteredForms.map((f) => (
              <li key={f.pathname}>
                <button
                  type="button"
                  onClick={() => handleContinue(f.pathname)}
                  className="w-full text-right py-2 px-3 rounded-md border border-gray-200 hover:bg-gray-50 flex flex-col gap-0.5"
                >
                  <span className="font-medium text-gray-900">{f.displayName}</span>
                  <span className="text-xs text-gray-500 font-mono" dir="ltr">
                    {f.formId || '—'} · {f.uploadedAt ? new Date(f.uploadedAt).toLocaleString('he-IL') : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
