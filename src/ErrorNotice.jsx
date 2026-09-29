import { useEffect, useRef } from 'react'
import { toHebrewError } from './lib/hebrewError.js'

/**
 * Small Hebrew failure dialog. Empty message renders nothing.
 * @param {{ message?: string, onClose: () => void }} props
 */
export default function ErrorNotice({ message, onClose }) {
  const closeRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const text = message ? toHebrewError(message) : ''

  useEffect(() => {
    if (!text) return undefined
    closeRef.current?.focus()
    const onKey = (event) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [text])

  if (!text) return null

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="error-notice-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl" dir="rtl">
        <h2 id="error-notice-title" className="text-base font-bold text-gray-900">
          שגיאה
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-700">{text}</p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
        >
          סגור
        </button>
      </div>
    </div>
  )
}
