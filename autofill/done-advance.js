/**
 * {"type":"done"} from the planner/vision agent means "this page has no more
 * fills", not "the application is finished". The run is complete only after
 * Sign and Submit and the confirmation PDFs are saved.
 */

function navText(action) {
  return String(action?.text || action?.label || '').trim()
}

export function isDoneAction(action) {
  return action?.type === 'done'
}

export function isAdvanceClick(action) {
  if (!action) return false
  if (action.type === 'reviewNext') return true
  if (action.type !== 'click') return false
  const text = navText(action).toLowerCase()
  return /^(next|continue)\b/.test(text) || text === 'print application'
}

const SUBMIT_BLOCKLIST = [
  'sign and submit',
  'submit application',
  'submit this application',
  'final submit',
  'submit now',
]

function isBlockedSubmit(action) {
  if (action?.type !== 'click' || !action.text) return false
  const text = navText(action)
  if (/^next\s*:\s*sign and submit$/i.test(text)) return false
  const lower = text.toLowerCase()
  return SUBMIT_BLOCKLIST.some((blocked) => lower.includes(blocked))
}

/** Click Next after this long with no field action or page change. */
export const IDLE_NEXT_MS = 15_000

const IDLE_NEXT_BLOCKED = new Set([
  'captcha',
  'photo',
  'sign_submit',
  'signed',
  'confirmation',
])

/**
 * A reload or a short-circuit loop can sit on the same form page without
 * filling anything. Next makes CEAC show the validation error, and the
 * following step plans from that error.
 */
export function shouldForceNextAfterIdle(idleMs, pageContext) {
  if (!Number.isFinite(idleMs) || idleMs < IDLE_NEXT_MS) return false
  return !IDLE_NEXT_BLOCKED.has(pageContext)
}

export function nextAdvanceAction({ inventory, pageContext } = {}) {
  if (pageContext === 'confirmation') {
    return { type: 'click', text: 'Print Application' }
  }
  if (pageContext === 'signed') {
    return { type: 'click', text: 'Next: Confirmation' }
  }
  if (pageContext === 'review') return { type: 'reviewNext' }
  if (pageContext === 'sign_submit' || pageContext === 'captcha') return null

  const buttons = inventory?.buttons || []
  const next =
    buttons.find((button) => /^next\b/i.test(button.text || '')) ||
    buttons.find((button) => /^continue\b/i.test(button.text || ''))
  const action = { type: 'click', text: next?.text || 'Next' }
  return isBlockedSubmit(action) ? null : action
}

export function stripDoneActions(actions = []) {
  return actions.filter((action) => !isDoneAction(action))
}

export function queueWithAdvance(actions, nextClick) {
  const out = stripDoneActions(actions)
  if (nextClick && !isBlockedSubmit(nextClick) && !out.some(isAdvanceClick)) {
    out.push(nextClick)
  }
  return out
}
