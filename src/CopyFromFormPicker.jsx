import { useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { listFormBlobsFromApi, fetchFormBlobPayload } from './lib/formBlob.js'
import {
  COPYABLE_SECTIONS,
  extractSectionFromPayload,
  previewSectionValues,
} from './lib/copyFromFormSections.js'

/**
 * Modal: fuzzy-search other saved forms by Hebrew display name, then copy a section.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   sectionId: string,
 *   excludePathname?: string | null,
 *   excludeFormId?: string | null,
 *   onCopy: (values: Record<string, unknown>, meta: { pathname: string, displayName: string }) => void,
 * }} props
 */
export default function CopyFromFormPicker({
  open,
  onClose,
  sectionId,
  excludePathname,
  excludeFormId,
  onCopy,
}) {
  const section = COPYABLE_SECTIONS[sectionId]
  const [forms, setForms] = useState([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    setQuery('')
    setSelected(null)
    setPreview(null)
    setPreviewError('')
    setListError('')
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const data = await listFormBlobsFromApi()
        if (cancelled) return
        const list = Array.isArray(data.forms) ? data.forms : []
        setForms(
          list
            .filter((f) => {
              if (excludePathname && f.pathname === excludePathname) return false
              if (excludeFormId && (f.formId === excludeFormId || String(f.pathname || '').includes(`_${excludeFormId}.`))) {
                return false
              }
              return true
            })
            .map((f) => {
              const parts = String(f.displayName || '')
                .trim()
                .split(/\s+/)
                .filter(Boolean)
              return {
                ...f,
                firstName: parts[0] || '',
                lastName: parts.slice(1).join(' ') || '',
              }
            }),
        )
      } catch (e) {
        if (!cancelled) {
          setListError(e?.message || 'לא ניתן לטעון רשימת טפסים')
          setForms([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, excludePathname, excludeFormId])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 50)
    return () => window.clearTimeout(t)
  }, [open])

  const matches = useMemo(() => {
    const q = query.trim()
    if (!q) return forms.slice(0, 12)
    const fuse = new Fuse(forms, {
      keys: [
        { name: 'displayName', weight: 0.6 },
        { name: 'firstName', weight: 0.2 },
        { name: 'lastName', weight: 0.2 },
      ],
      threshold: 0.45,
      ignoreLocation: true,
    })
    return fuse.search(q).slice(0, 12).map((r) => r.item)
  }, [forms, query])

  async function handleSelectForm(form) {
    setSelected(form)
    setPreview(null)
    setPreviewError('')
    setPreviewLoading(true)
    try {
      const { payload } = await fetchFormBlobPayload(form.pathname)
      const values = extractSectionFromPayload(payload, sectionId)
      if (!values) {
        setPreviewError('בטופס זה אין נתונים להעתקה עבור הסעיף הזה.')
        setPreview(null)
        return
      }
      setPreview({ values, lines: previewSectionValues(sectionId, values) })
    } catch (e) {
      setPreviewError(e?.message || 'טעינת הטופס נכשלה')
      setPreview(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  function handleConfirmCopy() {
    if (!selected || !preview?.values) return
    onCopy(preview.values, { pathname: selected.pathname, displayName: selected.displayName })
    onClose()
  }

  if (!open || !section) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="copy-from-form-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 flex flex-col gap-4 max-h-[90vh]" dir="rtl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="copy-from-form-title" className="text-lg font-bold text-gray-800">
              העתק מטופס אחר
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              העתקת: {section.label}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-sm"
            aria-label="סגור"
          >
            ✕
          </button>
        </div>

        <div>
          <label htmlFor="copy-form-search" className="block text-sm font-medium text-gray-700 mb-1">
            חיפוש לפי שם (פרטי / משפחה)
          </label>
          <input
            ref={inputRef}
            id="copy-form-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="הקלד שם…"
            autoComplete="off"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-right focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            disabled={loading}
          />
        </div>

        {listError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{listError}</p>
        )}

        <div className="border border-gray-200 rounded-lg overflow-hidden min-h-[8rem] max-h-48 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-gray-500 p-3">טוען טפסים…</p>
          ) : matches.length === 0 ? (
            <p className="text-sm text-gray-500 p-3">
              {query.trim() ? 'לא נמצאו תוצאות' : 'אין טפסים אחרים במערכת'}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {matches.map((f) => {
                const isActive = selected?.pathname === f.pathname
                return (
                  <li key={f.pathname}>
                    <button
                      type="button"
                      onClick={() => void handleSelectForm(f)}
                      className={`w-full text-right px-3 py-2.5 text-sm transition ${
                        isActive ? 'bg-blue-50 text-blue-900 font-semibold' : 'hover:bg-gray-50 text-gray-800'
                      }`}
                    >
                      {f.displayName || f.pathname}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {(previewLoading || previewError || preview) && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-1">
            <p className="text-xs font-semibold text-gray-600">תצוגה מקדימה</p>
            {previewLoading && <p className="text-sm text-gray-500">טוען…</p>}
            {previewError && <p className="text-sm text-red-600">{previewError}</p>}
            {preview && (
              <ul className="text-sm text-gray-800 space-y-0.5">
                {preview.lines.map((line, i) => (
                  <li key={i} dir="auto">{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            disabled={!preview?.values || previewLoading}
            onClick={handleConfirmCopy}
            className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            העתק לסעיף זה
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition"
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  )
}
