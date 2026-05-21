import { useEffect, useState } from 'react'

/**
 * Renders a single editable form field.
 */
function GuestField({ field, label, type, options, value, onChange, isFilled }) {
  const baseInput =
    'w-full rounded-md border px-3 py-2 text-right focus:outline-none focus:ring-1 focus:ring-blue-500 ' +
    (isFilled ? 'border-green-400 bg-green-50' : 'border-gray-300 focus:border-blue-500')

  const savedBadge = isFilled ? (
    <span className="text-xs text-green-700 font-medium bg-green-100 px-2 py-0.5 rounded-full">
      ✓ נשמר
    </span>
  ) : null

  if (type === 'radio' && Array.isArray(options)) {
    return (
      <fieldset>
        <legend className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
          {label} {savedBadge}
        </legend>
        <div className="flex gap-4 flex-wrap">
          {options.map((opt) => (
            <label key={opt} className="flex items-center gap-1.5 text-sm text-gray-800 cursor-pointer">
              <input
                type="radio"
                name={field}
                value={opt}
                checked={value === opt}
                onChange={(e) => onChange(e.target.value)}
                className="accent-blue-600"
              />
              {opt}
            </label>
          ))}
        </div>
      </fieldset>
    )
  }

  if (type === 'select' && Array.isArray(options)) {
    return (
      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1">
          {label} {savedBadge}
        </label>
        <select value={value} onChange={(e) => onChange(e.target.value)} className={baseInput}>
          <option value="">— בחר —</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    )
  }

  if (type === 'textarea') {
    return (
      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1">
          {label} {savedBadge}
        </label>
        <textarea
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={baseInput}
        />
      </div>
    )
  }

  return (
    <div>
      <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-1">
        {label} {savedBadge}
      </label>
      <input
        type={
          type === 'number' ? 'number'
          : type === 'date' ? 'date'
          : type === 'email' ? 'email'
          : 'text'
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={baseInput}
      />
    </div>
  )
}

export default function MiniFormGuest({ guestToken }) {
  const [phase, setPhase] = useState('loading') // loading | form | submitting | success | error
  const [formContext, setFormContext] = useState(null)
  /** All fields the client was originally invited to fill, annotated with currentValue + isFilled */
  const [guestFields, setGuestFields] = useState([])
  const [answers, setAnswers] = useState({})
  const [submitError, setSubmitError] = useState('')
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!guestToken) {
      setLoadError('קישור לא תקף')
      setPhase('error')
      return
    }

    fetch(`/api/guest-form?token=${encodeURIComponent(guestToken)}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, json: j })))
      .then(({ ok, json }) => {
        if (!ok) {
          setLoadError(json.error || 'קישור לא תקף')
          setPhase('error')
          return
        }
        setFormContext(json.formContext)

        const fields = json.guestFields || json.missingFields || []
        setGuestFields(fields)

        // Pre-populate with current saved values (empty string for unfilled)
        const initial = {}
        for (const f of fields) {
          initial[f.field] = f.currentValue ?? ''
        }
        setAnswers(initial)
        setPhase('form')
      })
      .catch((e) => {
        setLoadError(e?.message || 'שגיאת רשת')
        setPhase('error')
      })
  }, [guestToken])

  function setAnswer(field, value) {
    setAnswers((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitError('')
    setPhase('submitting')
    try {
      const res = await fetch(`/api/guest-form?token=${encodeURIComponent(guestToken)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      })
      const json = await res.json()
      if (!res.ok) {
        setSubmitError(json.error || 'שגיאה בשליחה')
        setPhase('form')
        return
      }
      setPhase('success')
    } catch (e) {
      setSubmitError(e?.message || 'שגיאת רשת')
      setPhase('form')
    }
  }

  if (phase === 'loading') {
    return (
      <div dir="rtl" className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500 text-sm">טוען…</p>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div dir="rtl" className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full bg-white shadow-lg rounded-xl p-8 text-center space-y-3">
          <p className="text-2xl">⚠️</p>
          <p className="font-semibold text-gray-800">הקישור אינו תקף</p>
          <p className="text-sm text-gray-500">{loadError}</p>
        </div>
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div dir="rtl" className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full bg-white shadow-lg rounded-xl p-8 text-center space-y-3">
          <p className="text-4xl">✅</p>
          <p className="text-xl font-bold text-gray-900">תודה!</p>
          <p className="text-sm text-gray-600">
            הפרטים נשמרו בהצלחה. הנציג שלך יוכל להמשיך את הגשת הבקשה.
          </p>
        </div>
      </div>
    )
  }

  const isSubmitting = phase === 'submitting'
  const filledCount = guestFields.filter((f) => f.isFilled).length
  const pendingCount = guestFields.length - filledCount
  const allDone = pendingCount === 0

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50 py-10 px-4 font-sans">
      <div className="max-w-lg mx-auto bg-white shadow-xl rounded-xl p-8 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            השלמת פרטים — {formContext?.name}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            אנא מלא את השדות הנדרשים כדי שנוכל להגיש את בקשת הוויזה שלך.
          </p>
          {guestFields.length > 0 && (
            <div className="mt-3 flex gap-3 text-xs">
              {filledCount > 0 && (
                <span className="bg-green-100 text-green-700 px-2 py-1 rounded-full font-medium">
                  ✓ {filledCount} שדות נשמרו
                </span>
              )}
              {pendingCount > 0 && (
                <span className="bg-orange-100 text-orange-700 px-2 py-1 rounded-full font-medium">
                  {pendingCount} שדות ממתינים
                </span>
              )}
            </div>
          )}
        </div>

        {allDone ? (
          <p className="text-green-700 text-sm bg-green-50 border border-green-200 rounded-md px-3 py-2">
            כל הפרטים שהתבקשת למלא כבר נשמרו. תוכל לעדכן אותם ולשלוח שוב אם תרצה.
          </p>
        ) : null}

        {guestFields.length === 0 ? (
          <p className="text-gray-500 text-sm">אין שדות להשלמה.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {guestFields.map((f) => (
              <GuestField
                key={f.field}
                field={f.field}
                label={f.label}
                type={f.type}
                options={f.options}
                value={answers[f.field] ?? ''}
                onChange={(v) => setAnswer(f.field, v)}
                isFilled={f.isFilled}
              />
            ))}

            {submitError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                {submitError}
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3 px-4 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 transition disabled:opacity-50"
            >
              {isSubmitting ? 'שולח…' : allDone ? 'עדכן פרטים' : 'שלח פרטים'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
