function text(value) {
  return String(value ?? '').trim()
}

function digits(value) {
  return text(value).replace(/\D/g, '')
}

function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value))
  if (!match) return false
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
}

function normalized(value, format) {
  const valueText = text(value)
  if (format === 'ssn' || format === 'nationalId') return digits(valueText)
  if (format === 'passport' || format === 'license') {
    return valueText.toUpperCase().replace(/[\s-]/g, '')
  }
  if (format === 'sex') return valueText.toUpperCase().slice(0, 1)
  return valueText.toUpperCase().replace(/\s+/g, ' ')
}

function validationWarning(value, field) {
  const valueText = text(value)
  if (!valueText) return field.required ? 'Required value was not detected' : ''

  if (field.format === 'date' && !isIsoDate(valueText)) return 'Expected a valid YYYY-MM-DD date'
  if (field.format === 'passport' && !/^[A-Z0-9]{5,15}$/i.test(normalized(valueText, field.format))) {
    return 'Passport number format is invalid'
  }
  if (field.format === 'ssn' && !/^\d{9}$/.test(digits(valueText))) return 'SSN must contain exactly 9 digits'
  if (field.format === 'nationalId' && !/^\d{9}$/.test(digits(valueText))) {
    return 'Israeli ID must contain exactly 9 digits'
  }
  if (field.format === 'sex' && !/^[MF]$/.test(normalized(valueText, field.format))) {
    return 'Sex must be M or F'
  }
  if (field.format === 'confirmed' && value !== true && valueText.toLowerCase() !== 'true') {
    return 'The visual field and MRZ did not agree'
  }
  return ''
}

export async function runTwoPassOcr(extract, file) {
  const results = await Promise.allSettled([extract(file), extract(file)])
  const successful = results.filter((result) => result.status === 'fulfilled')
  if (successful.length === 0) throw results[0].reason

  return {
    first: results[0].status === 'fulfilled' ? results[0].value : {},
    second: results[1].status === 'fulfilled' ? results[1].value : {},
    passErrors: results.map((result) =>
      result.status === 'rejected' ? String(result.reason?.message || result.reason || 'OCR request failed') : ''),
  }
}

export function compareOcrPasses(first, second, fields, passErrors = []) {
  const rows = fields.map((field) => {
    const firstValue = text(first?.[field.key])
    const secondValue = text(second?.[field.key])
    const agrees = normalized(firstValue, field.format) === normalized(secondValue, field.format)
    const value = firstValue || secondValue
    const warning = validationWarning(value, field)
    return {
      ...field,
      firstValue,
      secondValue,
      value,
      agrees,
      warning,
      requiresReview: !agrees || !!warning,
    }
  })
  for (const row of rows) {
    if (!row.after || !isIsoDate(row.value)) continue
    const earlier = rows.find((candidate) => candidate.key === row.after)
    if (!earlier || !isIsoDate(earlier.value)) continue
    if (row.value <= earlier.value) {
      row.warning = `${row.label} must be after ${earlier.label}`
      row.requiresReview = true
    }
  }

  const failedPass = passErrors.some(Boolean)
  return {
    rows,
    needsReview: failedPass || rows.some((row) => row.requiresReview),
    reasons: [
      ...passErrors.filter(Boolean).map((error, index) => `OCR pass ${index + 1} failed: ${error}`),
      ...rows.filter((row) => !row.agrees).map((row) => `${row.label}: OCR passes disagree`),
      ...rows.filter((row) => row.warning).map((row) => `${row.label}: ${row.warning}`),
    ],
    approved: Object.fromEntries(rows.map((row) => [row.key, row.value])),
  }
}
