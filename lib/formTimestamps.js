/**
 * Created / updated timestamps stored on the form status index and blob JSON.
 * Date-only values (YYYY-MM-DD) are kept as-is so the list can show the day
 * without inventing a clock time.
 */

function asTrimmed(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/** @param {unknown} value @returns {string | null} */
export function normalizeTimestamp(value) {
  const raw = asTrimmed(value)
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/** @param {unknown} payload */
export function createdAtFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
  return (
    normalizeTimestamp(payload.createdAt) ||
    normalizeTimestamp(data.createdAt) ||
    normalizeTimestamp(data.formStartedDate)
  )
}

/**
 * @param {Record<string, unknown> | null | undefined} prev
 * @param {unknown} payload
 * @param {string | null} now full ISO time for a brand-new save, or null when only reading history
 */
export function resolveCreatedAt(prev, payload, now) {
  return (
    normalizeTimestamp(prev?.createdAt) ||
    createdAtFromPayload(payload) ||
    (now ? normalizeTimestamp(now) : null)
  )
}

/**
 * @param {Record<string, unknown> | null | undefined} prev
 * @param {{ now?: string | null, uploadedAt?: string | null, payload?: unknown }} source
 */
export function resolveUpdatedAt(prev, source = {}) {
  return (
    normalizeTimestamp(source.now) ||
    normalizeTimestamp(prev?.updatedAt) ||
    normalizeTimestamp(source.uploadedAt) ||
    null
  )
}
