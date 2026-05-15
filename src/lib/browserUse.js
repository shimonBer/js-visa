/**
 * Calls /api/browser-use with traveller data; server holds BROWSER_USE_API_KEY.
 * @param {{ firstName: string, lastName: string, birthDate: string, passportNumber: string, country: string, formContext?: unknown }} input
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ success: boolean, history: { date: string, type: string, location: string }[] }>}
 */
export async function fetchI94TravelHistory(input, opts = {}) {
  // Server polls up to 120s + create request; allow headroom on the client
  const timeoutMs = opts.timeoutMs ?? 125_000
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)

  let res
  try {
    res = await fetch('/api/browser-use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: input.firstName,
        lastName: input.lastName,
        birthDate: input.birthDate,
        passportNumber: input.passportNumber,
        country: input.country,
        ...(input.formContext != null && typeof input.formContext === 'object'
          ? { formContext: input.formContext }
          : {}),
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(t)
  }

  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(text.slice(0, 400) || `I-94 lookup failed (${res.status})`)
  }

  if (!res.ok) {
    throw new Error(json.error || json.detail || `I-94 lookup failed (${res.status})`)
  }

  return {
    success: Boolean(json.success),
    history: Array.isArray(json.history)
      ? json.history.map((h) => ({
          date: String(h?.date ?? ''),
          type: String(h?.type ?? ''),
          location: String(h?.location ?? ''),
        }))
      : [],
  }
}
