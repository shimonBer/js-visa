/**
 * The English review is what the PDF prints. The answer sheet and every DS-160
 * text fill must use those same characters. A later model pass may respell a
 * name (YIGAL → IGAL); this puts the review spelling back.
 */

const MARKER_RE =
  /^(?:n\/?a|none|does not apply|do not know|unknown|❗?\s*missing)$/i

function compact(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/** "Given Names" and "given_names" both become "givenname". */
function labelKey(value) {
  return compact(value).replace(/s$/, '')
}

function isDisplayOrIsoDate(value) {
  const text = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)
}

function digitRun(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function isPhoneLike(value) {
  const text = String(value ?? '').trim()
  const digits = digitRun(text)
  return digits.length >= 6 && digits.length >= text.replace(/\s/g, '').length - 4
}

/**
 * A review label matches a sheet key or a form label when they are the same
 * phrase, or when the longer one is the shorter one with a qualifier in front
 * ("Previous Employer Supervisor Given Names" ↔ "Supervisor Given Name").
 * Short words such as "City" only match exactly, so one city cannot adopt another.
 */
export function reviewLabelsMatch(a, b) {
  const left = labelKey(a)
  const right = labelKey(b)
  if (!left || !right) return false
  if (left === right) return true
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (shorter.length < 8) return false
  return longer.endsWith(shorter)
}

export function parseReviewLines(text) {
  const lines = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('🟦') || line.startsWith('━━━')) continue
    const colon = line.indexOf(':')
    const question = line.indexOf('?')
    if (!(colon > 0 && (question < 0 || colon < question))) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key && value) lines.push({ key, value })
  }
  return lines
}

function reviewLineFor(path, lines) {
  const last = path[path.length - 1] || ''
  const joined = path.join(' ')
  const hits = lines.filter((line) => (
    reviewLabelsMatch(last, line.key) || reviewLabelsMatch(joined, line.key)
  ))
  const exact = hits.filter((line) => (
    labelKey(line.key) === labelKey(last) || labelKey(line.key) === labelKey(joined)
  ))
  let pool = exact.length ? exact : hits
  if (pool.length > 1) {
    // "Given Name" and "Supervisor Given Name" both match a supervisor label.
    // The longer label is the one this field is asking for.
    const bestLength = Math.max(...pool.map((line) => labelKey(line.key).length))
    pool = pool.filter((line) => labelKey(line.key).length === bestLength)
  }
  if (pool.length !== 1) return null
  const reviewValue = pool[0].value.trim()
  if (!reviewValue || reviewValue.length > 200 || MARKER_RE.test(reviewValue)) return null
  return pool[0]
}

/**
 * "IGAL" / "YIGAL" and "ILANIT" / "LILANIT": the same name with one or two
 * letters added at an end. A different word is not a spelling variant.
 */
function isNearSpelling(a, b) {
  const left = String(a).trim().toLowerCase()
  const right = String(b).trim().toLowerCase()
  if (!left || !right) return false
  if (left === right) return true
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (shorter.length < 3 || longer.length - shorter.length > 2) return false
  return longer.startsWith(shorter) || longer.endsWith(shorter)
}

/**
 * Replace one sheet/fill string with the review line for the same label.
 * Dates and phone numbers keep the form the filler already needs.
 * A short label such as "City" is replaced only when the two values are the
 * same name spelled differently, so one city cannot overwrite another.
 */
export function alignStringToReview(path, value, lines) {
  const current = String(value ?? '').trim()
  if (!current || isDisplayOrIsoDate(current) || isPhoneLike(current)) return value
  const line = reviewLineFor(path, lines)
  if (!line) return value
  const reviewValue = line.value.trim()
  if (isDisplayOrIsoDate(reviewValue)) return value
  if (digitRun(current) && digitRun(current) === digitRun(reviewValue)) return value
  const specific = labelKey(line.key).length >= 6
  if (!specific && !isNearSpelling(current, reviewValue)) return value
  return reviewValue
}

function walk(node, path, lines) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      if (typeof item === 'string') {
        const locked = alignStringToReview(path, item, lines)
        if (locked !== item) node[index] = locked
      } else if (item && typeof item === 'object') {
        walk(item, path, lines)
      }
    })
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    const next = path.concat(key)
    if (typeof value === 'string') {
      const locked = alignStringToReview(next, value, lines)
      if (locked !== value) node[key] = locked
    } else if (value && typeof value === 'object') {
      walk(value, next, lines)
    }
  }
}

/** Copy review spellings onto the answer sheet. Dates and phones stay as stored. */
export function lockAnswerSheetToReview(sheet, reviewText) {
  if (!sheet || typeof sheet !== 'object') return sheet
  const copy = structuredClone(sheet)
  walk(copy, [], parseReviewLines(reviewText))
  return copy
}

/**
 * A planner or vision fill must type the review's characters, not a respelling.
 * The returned action is the same object when nothing changes.
 */
export function snapFillValue(action, reviewText) {
  if (!action || action.type !== 'fill' || action.value == null) return action
  const lines = parseReviewLines(reviewText)
  const labels = [action.fieldLabel, action.label].filter(Boolean)
  for (const label of labels) {
    const snapped = alignStringToReview([label], action.value, lines)
    if (String(snapped) !== String(action.value)) {
      return { ...action, value: snapped }
    }
  }
  return action
}
