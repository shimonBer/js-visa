const storageKey = (formId) => `ds160_form_${formId}`

/**
 * Saves JSON-serializable form snapshot in the browser (localStorage).
 * Suitable for Vercel static hosting — not synced across devices.
 */
export function saveFormDraftToBrowser(formId, record) {
  if (!formId) return
  const payload = {
    formId,
    ...record,
    localSavedAt: new Date().toISOString(),
  }
  try {
    localStorage.setItem(storageKey(formId), JSON.stringify(payload))
  } catch (e) {
    if (e?.name === 'QuotaExceededError') {
      throw new Error('אחסון הדפדפן מלא — לא ניתן לשמור טיוטה מקומית')
    }
    throw e
  }
}

/** @returns {object | null} */
export function loadFormDraftFromBrowser(formId) {
  if (!formId) return null
  const raw = localStorage.getItem(storageKey(formId))
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
