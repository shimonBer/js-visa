/** Decide when the extension should stop looping on an unchanged CEAC page. */

export function isNavigationClick(action) {
  if (!action) return false
  if (action.type === 'reviewNext') return true
  if (action.type !== 'click') return false
  const text = String(action.text || action.label || '').toLowerCase()
  return /^(next|continue)\b/.test(text) || text.includes('next:')
}

export function isFieldAction(action) {
  return Boolean(action) && !isNavigationClick(action) && action.type !== 'done' && action.type !== 'defer'
}

export function pageLooksComplete(planned) {
  const actions = planned?.actions || []
  const fields = actions.filter(isFieldAction).filter((action) => action.type !== 'wait')
  const unresolved = planned?.unresolvedRequired?.length || 0
  return fields.length === 0 && unresolved === 0
}

function isCaptchaLandingUrl(href) {
  const url = String(href || '').toLowerCase()
  if (/default\.aspx/i.test(url)) return true
  return /\/genniv\/?(\?|#|$)/i.test(url)
}

/** After two identical snapshots, stop editing and click Next — never on CAPTCHA. */
export function shouldForceNextWhenStuck(stuck, { pageContext, href } = {}) {
  if (pageContext === 'captcha' || pageContext === 'signed' || pageContext === 'confirmation') return false
  if (pageContext === 'sign_submit') return false
  if (pageContext === 'unknown' && isCaptchaLandingUrl(href)) return false
  if (pageContext === 'photo' && !/confirmphoto/i.test(href || '')) return false
  return stuck >= 2
}

/** Give up only after several forced Next clicks still leave the same page. */
export function shouldGiveUpWhenStuck(stuck) {
  return stuck >= 8
}
