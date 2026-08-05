import { useEffect, useMemo, useState } from 'react'

export default function OcrReviewDialog({ review, onApprove, onDiscard }) {
  const [values, setValues] = useState({})
  const [previewUrl, setPreviewUrl] = useState('')

  useEffect(() => {
    if (!review) return
    setValues(review.approved || {})
  }, [review])

  useEffect(() => {
    if (!review?.file) {
      setPreviewUrl('')
      return undefined
    }
    const url = URL.createObjectURL(review.file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [review])

  const reviewRows = useMemo(
    () => review?.rows?.filter((row) => row.requiresReview) || [],
    [review],
  )
  const missingRequired = reviewRows.some(
    (row) => row.required && !String(values[row.key] ?? '').trim(),
  )

  if (!review) return null

  const isPdf = review.file?.type === 'application/pdf'

  return (
    <div className="fixed inset-0 z-[80] bg-black/60 p-4 overflow-y-auto" dir="rtl">
      <div className="mx-auto max-w-6xl rounded-xl bg-white shadow-2xl overflow-hidden">
        <div className="border-b border-amber-200 bg-amber-50 p-4">
          <h2 className="text-lg font-bold text-amber-900">נדרשת בדיקה אנושית — {review.title}</h2>
          <p className="mt-1 text-sm text-amber-800">
            שתי קריאות OCR לא הסכימו או שאחד הערכים נכשל בבדיקה. יש לאשר את הערכים לפני התרגום.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
          <div className="rounded-lg border border-gray-200 bg-gray-50 min-h-80 overflow-hidden">
            {previewUrl && isPdf && (
              <iframe title="מסמך לבדיקה" src={previewUrl} className="h-[70vh] w-full" />
            )}
            {previewUrl && !isPdf && (
              <img src={previewUrl} alt="מסמך לבדיקה" className="max-h-[70vh] w-full object-contain" />
            )}
          </div>

          <div className="space-y-4">
            {review.reasons?.length > 0 && (
              <ul className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 space-y-1">
                {review.reasons.map((reason) => <li key={reason}>• {reason}</li>)}
              </ul>
            )}

            {reviewRows.map((row) => (
              <div key={row.key} className="rounded-lg border border-gray-200 p-3 space-y-2">
                <p className="font-semibold text-gray-800">{row.label}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm" dir="ltr">
                  <div className="rounded bg-blue-50 p-2">
                    <span className="block text-xs text-blue-600">OCR pass 1</span>
                    <span className="font-mono break-all">{row.firstValue || '—'}</span>
                  </div>
                  <div className="rounded bg-purple-50 p-2">
                    <span className="block text-xs text-purple-600">OCR pass 2</span>
                    <span className="font-mono break-all">{row.secondValue || '—'}</span>
                  </div>
                </div>
                {row.warning && <p className="text-xs text-red-600">{row.warning}</p>}
                <label className="block text-sm font-medium text-gray-700">ערך מאושר</label>
                <input
                  value={values[row.key] ?? ''}
                  onChange={(event) => setValues((current) => ({
                    ...current,
                    [row.key]: event.target.value,
                  }))}
                  className="w-full rounded-md border border-amber-400 p-2 font-mono"
                  dir="ltr"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-2 border-t border-gray-200 p-4">
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
          >
            בטל את תוצאות ה-OCR והזן ידנית
          </button>
          <button
            type="button"
            disabled={missingRequired}
            onClick={() => onApprove(values)}
            className="rounded-md bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            אשר והמשך
          </button>
        </div>
      </div>
    </div>
  )
}
