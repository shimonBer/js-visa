import { useEffect, useMemo, useRef, useState } from 'react'
import { authHeaders } from './lib/auth.js'

const LOCAL_FILL = 'http://127.0.0.1:47821'
const FILTERS = [
  { id: 'all', label: 'הכל' },
  { id: 'pending', label: 'ממתין' },
  { id: 'success', label: 'הצליח' },
  { id: 'fail', label: 'נכשל' },
]

const STATUS = {
  pending: { label: 'ממתין לריצה', className: 'bg-amber-100 text-amber-800' },
  success: { label: 'הצליח', className: 'bg-emerald-100 text-emerald-800' },
  fail: { label: 'נכשל', className: 'bg-red-100 text-red-800' },
  stopped: { label: 'נעצר', className: 'bg-gray-200 text-gray-700' },
}

function formatWhen(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function mergeRuns(cloud, local) {
  const map = new Map()
  for (const run of cloud) {
    if (run?.id) map.set(run.id, { ...run })
  }
  for (const run of local) {
    if (!run?.id) continue
    const prev = map.get(run.id)
    if (!prev) {
      map.set(run.id, { ...run, hasShot: Boolean(run.hasShot || run.shotUrl) })
      continue
    }
    const localNewer = String(run.ts || '') >= String(prev.ts || '')
    const next = localNewer ? { ...prev, ...run } : { ...run, ...prev }
    next.shotUrl = run.shotUrl || prev.shotUrl || ''
    next.hasShot = Boolean(prev.hasShot || run.hasShot || next.shotUrl)
    next.logExcerpt = (localNewer ? run.logExcerpt : prev.logExcerpt) || prev.logExcerpt || run.logExcerpt || ''
    next.reason = (localNewer ? run.reason : prev.reason) || prev.reason || run.reason || ''
    map.set(run.id, next)
  }
  return [...map.values()].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
}

async function fetchRuns(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || 'לא ניתן לטעון ריצות')
  }
  const data = await res.json()
  return Array.isArray(data.runs) ? data.runs : []
}

export default function AutofillMonitoring() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [localOnline, setLocalOnline] = useState(false)
  const [filter, setFilter] = useState('all')
  const [openId, setOpenId] = useState('')
  const [shots, setShots] = useState({})
  const shotsRef = useRef({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [cloudResult, localResult] = await Promise.allSettled([
        fetchRuns('/api/form-blob?fillRuns=1', { headers: authHeaders() }),
        fetchRuns(`${LOCAL_FILL}/api/runs`),
      ])
      if (cancelled) return
      const cloud = cloudResult.status === 'fulfilled' ? cloudResult.value : []
      const local = localResult.status === 'fulfilled' ? localResult.value : []
      setLocalOnline(localResult.status === 'fulfilled')
      setRuns(mergeRuns(cloud, local))
      if (cloudResult.status === 'rejected' && localResult.status === 'rejected') {
        setError(cloudResult.reason?.message || 'לא ניתן לטעון את היסטוריית הריצות')
      } else {
        setError('')
      }
      setLoading(false)
    }
    load()
    const timer = setInterval(load, 8000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => () => {
    for (const url of Object.values(shotsRef.current)) {
      if (String(url).startsWith('blob:')) URL.revokeObjectURL(url)
    }
  }, [])

  const visible = useMemo(() => {
    if (filter === 'all') return runs
    if (filter === 'fail') return runs.filter((run) => run.portalStatus === 'fail')
    return runs.filter((run) => run.portalStatus === filter)
  }, [runs, filter])

  async function toggle(run) {
    if (openId === run.id) {
      setOpenId('')
      return
    }
    setOpenId(run.id)
    if (shots[run.id] || (!run.shotUrl && !run.hasShot)) return
    try {
      let blob = null
      if (run.shotUrl) {
        const local = await fetch(`${LOCAL_FILL}${run.shotUrl}`).catch(() => null)
        if (local?.ok) blob = await local.blob()
      }
      if (!blob && run.hasShot) {
        const cloud = await fetch(`/api/form-blob?fillShot=${encodeURIComponent(run.id)}`, { headers: authHeaders() })
        if (cloud.ok) blob = await cloud.blob()
      }
      if (!blob) return
      const url = URL.createObjectURL(blob)
      shotsRef.current = { ...shotsRef.current, [run.id]: url }
      setShots((prev) => ({ ...prev, [run.id]: url }))
    } catch {
      /* screenshot is optional */
    }
  }

  return (
    <div dir="rtl" className="min-h-full bg-gray-100 px-4 py-6 text-right sm:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-xl font-bold text-gray-900">Autofill Monitoring</h1>
        <p className="mt-1 text-sm text-gray-500">
          היסטוריית ריצות המילוי. התראת מערכת קופצת בכל הצלחה או כשל, ומייל נשלח לכתובת שהוגדרה למילוי.
          {localOnline ? ' חלון המילוי במחשב הזה מחובר.' : ' חלון המילוי המקומי לא זמין כרגע — מוצג מה שנשמר בענן.'}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={`rounded-full px-3 py-1 text-sm font-medium ${
                filter === item.id ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 ring-1 ring-gray-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {loading && <p className="mt-8 text-sm text-gray-500">טוען ריצות…</p>}
        {error && <p className="mt-8 text-sm text-red-600">{error}</p>}
        {!loading && !error && visible.length === 0 && (
          <p className="mt-8 text-sm text-gray-500">אין ריצות להצגה.</p>
        )}

        <ul className="mt-4 space-y-2">
          {visible.map((run) => {
            const tone = STATUS[run.portalStatus] || STATUS.pending
            const open = openId === run.id
            return (
              <li key={run.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                <button
                  type="button"
                  onClick={() => toggle(run)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-right"
                >
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${tone.className}`}>
                    {tone.label}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-gray-900">{run.name || 'ללא שם'}</span>
                    <span className="mt-0.5 block text-xs text-gray-500">
                      {formatWhen(run.startedAt || run.ts)}
                      {run.appId ? ` · ${run.appId}` : ''}
                      {run.reason ? ` · ${run.reason}` : ''}
                    </span>
                  </span>
                </button>
                {open && (
                  <div className="space-y-3 border-t border-gray-100 px-4 py-3">
                    {shots[run.id] && (
                      <img src={shots[run.id]} alt="" className="max-h-80 w-full rounded-lg border border-gray-200 object-contain bg-gray-50" />
                    )}
                    {run.logExcerpt ? (
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-950 p-3 text-left text-xs leading-5 text-gray-100" dir="ltr">
                        {run.logExcerpt}
                      </pre>
                    ) : (
                      <p className="text-sm text-gray-500">אין לוג לריצה הזו.</p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
