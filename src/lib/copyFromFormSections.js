/**
 * Registry of copyable form sections.
 * Add new section ids here, then wire CopyFromFormPicker with that sectionId.
 */

/** @typedef {{ id: string, label: string, fields: string[] }} CopyableSection */

/** @type {Record<string, CopyableSection>} */
export const COPYABLE_SECTIONS = {
  accommodation: {
    id: 'accommodation',
    label: 'כתובת לינה בארה״ב',
    fields: [
      'hasExactAccommodationAddress',
      'accommodationCityPreset',
      'accommodationStreet1',
      'accommodationStreet2',
      'accommodationCity',
      'accommodationState',
      'accommodationStateNA',
      'accommodationZip',
      'accommodationZipNA',
    ],
  },
}

/**
 * Pull section field values from a saved blob payload (`{ data: {...} }` or raw data object).
 * @param {object | null | undefined} payload
 * @param {string} sectionId
 * @returns {Record<string, unknown> | null}
 */
export function extractSectionFromPayload(payload, sectionId) {
  const section = COPYABLE_SECTIONS[sectionId]
  if (!section) return null
  const data =
    payload?.data && typeof payload.data === 'object'
      ? payload.data
      : payload && typeof payload === 'object'
        ? payload
        : null
  if (!data) return null

  /** @type {Record<string, unknown>} */
  const out = {}
  let any = false
  for (const field of section.fields) {
    if (Object.prototype.hasOwnProperty.call(data, field) && data[field] !== undefined) {
      out[field] = data[field]
      any = true
    }
  }
  return any ? out : null
}

/**
 * Apply extracted section values into react-hook-form via setValue.
 * @param {(name: string, value: unknown, opts?: object) => void} setValue
 * @param {Record<string, unknown>} values
 */
export function applySectionValues(setValue, values) {
  if (!values || typeof values !== 'object') return
  for (const [name, value] of Object.entries(values)) {
    setValue(name, value, { shouldDirty: true, shouldValidate: true })
  }
}

/**
 * Human-readable preview lines for a copied section (MVP helpers).
 * @param {string} sectionId
 * @param {Record<string, unknown>} values
 * @returns {string[]}
 */
export function previewSectionValues(sectionId, values) {
  if (!values) return []
  if (sectionId === 'accommodation') {
    const lines = []
    if (values.hasExactAccommodationAddress === 'yes') {
      lines.push('כתובת מדויקת: כן')
      const street = [values.accommodationStreet1, values.accommodationStreet2]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .join(', ')
      if (street) lines.push(street)
      const cityLine = [values.accommodationCity, values.accommodationState, values.accommodationZip]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .join(', ')
      if (cityLine) lines.push(cityLine)
    } else if (values.hasExactAccommodationAddress === 'no') {
      lines.push('כתובת מדויקת: לא')
      const cityLine = [values.accommodationCity, values.accommodationState]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .join(', ')
      if (cityLine) lines.push(cityLine)
      else if (values.accommodationCityPreset) {
        lines.push(`עיר: ${String(values.accommodationCityPreset)}`)
      }
    } else {
      lines.push('אין נתוני לינה בטופס שנבחר')
    }
    return lines.length ? lines : ['אין נתוני לינה בטופס שנבחר']
  }
  return Object.entries(values)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}: ${String(v)}`)
}
