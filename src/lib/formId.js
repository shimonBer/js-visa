/** Normalized key: passport digits/letters + ISO date, e.g. 201381722_2026-08-01 */
export function buildFormId(passportId, passportDate) {
  const id = String(passportId ?? '').trim().replace(/[^A-Za-z0-9]/g, '')
  const d = String(passportDate ?? '').trim()
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return ''
  return `${id}_${d}`
}

/** Generate a new UUID for a fresh form session. */
export function generateFormUUID() {
  return crypto.randomUUID()
}
