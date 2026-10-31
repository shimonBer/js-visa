/**
 * Runs at document_start in the page MAIN world so CEAC's CheckBrowserClose.js
 * cannot install a beforeunload handler that shows Chrome's "Leave site?" dialog.
 * Keep in sync with autofill/agent.js disarmCeacUnloadInPage.
 */
(() => {
  const silence = () => {
    try { window.needToConfirm = false } catch { /* ignore */ }
    try { window.onbeforeunload = null } catch { /* ignore */ }
    try { window.onunload = null } catch { /* ignore */ }
    try { window.confirmExit = function confirmExit() {} } catch { /* ignore */ }
    try { window.__ds160SuppressExitWarning?.() } catch { /* ignore */ }
    try {
      if (typeof window.setDirty === 'function' && !window.setDirty.__ds160Wrapped) {
        const original = window.setDirty
        const wrapped = function setDirty() {
          try { return original.apply(this, arguments) } finally {
            try { window.needToConfirm = false } catch { /* ignore */ }
          }
        }
        wrapped.__ds160Wrapped = true
        window.setDirty = wrapped
      }
    } catch { /* ignore */ }
    if (typeof window.__doPostBack === 'function' && !window.__doPostBack.__ds160Wrapped) {
      const original = window.__doPostBack
      const wrapped = function wrappedDoPostBack(target) {
        const name = String(target || '')
        if (!window.__ds160AllowExit && /(?:^|\$)(?:lbtnExit|banner|lbtnHelp|lbtnContactUs)$/i.test(name)) {
          return
        }
        try { window.needToConfirm = false } catch { /* ignore */ }
        return original.apply(this, arguments)
      }
      wrapped.__ds160Wrapped = true
      window.__doPostBack = wrapped
    }
  }

  const chromeNav = (node) => {
    const el = node && node.closest ? node.closest('a, area, input, button') : null
    if (!el) return false
    const id = el.id || ''
    if ([
      'GetStarted', 'Personal', 'Travel', 'TravelCompanions', 'PreviousUSTravel',
      'AddressPhone', 'PptVisa', 'USContact', 'Family', 'WorkEducationMain', 'SecAndBackMain',
      'COMPLETE', 'PHOTO', 'REVIEW', 'ESIGN',
      'ctl00_lbtnExit', 'ctl00_lbtnHelp', 'ctl00_lbtnContactUs', 'ctl00_banner',
    ].includes(id)) return true
    return Boolean(el.closest('#sideNav, #nav-sidebar, #nav-global, #branding, #nav-main'))
  }

  window.__ds160SuppressExitWarning = () => {
    try { window.confirmExitPage = function confirmExitPage() { return false } } catch { /* ignore */ }
    if (window.__ds160AllowExit) return false
    try {
      const modal = window.$find && window.$find('modalExitWarning')
      if (modal && !modal.__ds160ShowBlocked) {
        modal.__ds160ShowBlocked = true
        modal.show = function show() {}
      }
    } catch { /* ignore */ }
    const fg = document.getElementById('modalExitWarning_foregroundElement')
    const bg = document.getElementById('modalExitWarning_backgroundElement')
    const panel = document.getElementById('ctl00_pnlExitWarning')
    const shown = (el) => {
      if (!el) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
    }
    if (!shown(fg) && !shown(panel)) return false
    try { if (typeof window.cancelPage === 'function') window.cancelPage() } catch { /* ignore */ }
    try {
      const modal = window.$find && window.$find('modalExitWarning')
      if (modal && typeof modal.hide === 'function') modal.hide()
    } catch { /* ignore */ }
    for (const el of [fg, bg, panel]) {
      if (el) el.style.display = 'none'
    }
    return true
  }

  const freeze = (name, getter) => {
    try { delete window[name] } catch { /* ignore */ }
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: getter,
        set() {},
      })
    } catch {
      try { window[name] = getter() } catch { /* ignore */ }
    }
  }

  freeze('needToConfirm', () => false)
  freeze('onbeforeunload', () => null)
  silence()

  if (window.__ds160UnloadArmed) return
  window.__ds160UnloadArmed = true

  const proto = EventTarget.prototype
  if (!proto.__ds160AddEventListenerPatched) {
    proto.__ds160AddEventListenerPatched = true
    const original = proto.addEventListener
    proto.addEventListener = function (type, listener, options) {
      if (String(type).toLowerCase() === 'beforeunload') return
      return original.call(this, type, listener, options)
    }
  }

  window.addEventListener('beforeunload', (event) => {
    silence()
    event.stopImmediatePropagation()
    event.stopPropagation()
    event.preventDefault()
    try { event.returnValue = undefined } catch { /* ignore */ }
  }, true)

  if (!window.__ds160UnloadTimer) {
    window.__ds160UnloadTimer = setInterval(silence, 100)
  }
  document.addEventListener('submit', silence, true)
  document.addEventListener('click', silence, true)
  document.addEventListener('click', (event) => {
    if (window.__ds160AllowExit) return
    if (!chromeNav(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }, true)

  if (!window.__ds160StartArmed) {
    window.__ds160StartArmed = true
    document.documentElement.addEventListener('ds160-start-application', () => {
      const el = document.querySelector(
        '#ctl00_SiteContentPlaceHolder_lnkNew, a[id$="lnkNew"], a[id*="lnkNew"], ' +
        '#ctl00_SiteContentPlaceHolder_ucLocationSearch_btnNewApp, input[id*="btnNewApp"], a[id*="btnNewApp"]',
      ) || [...document.querySelectorAll('a[role="Button"], a[role="button"]')].find((node) =>
        /start an application/i.test(node.textContent || ''),
      )
      if (!el) return
      el.removeAttribute('disabled')
      el.disabled = false
      silence()
      const href = el.getAttribute('href') || ''
      const postback = href.match(/__doPostBack\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/)
      if (postback && typeof window.__doPostBack === 'function') {
        window.__doPostBack(postback[1], postback[2])
        return
      }
      const uniqueId = el.getAttribute('name') || String(el.id || '').replace(/_/g, '$')
      if (typeof window.__doPostBack === 'function' && /lnkNew|btnNewApp/i.test(uniqueId)) {
        window.__doPostBack(uniqueId, '')
        return
      }
      el.click()
    })
  }
})()
