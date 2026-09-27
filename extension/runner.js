import {
  MAX_CAPTCHA_TRIES,
  MAX_SIGN_SUBMIT_TRIES,
  shouldRefreshCaptchaBeforeOcr,
} from './sign-submit-policy.js'
import { isFieldAction, isNavigationClick, shouldForceNextWhenStuck, shouldGiveUpWhenStuck } from './stuck-policy.js'

const BRIDGE = 'http://127.0.0.1:8787'
const MAX_PAGES = 160
const REVEAL_WAIT_MS = 5000
const FIELD_PAUSE_MS = 280
const NAV_PAUSE_MS = 1100
const HARD_BLOCK_NOTE =
  'CEAC blocked this session (Cloudflare). The extension cannot unblock it. Stop clicking Fill. Wait, then Retrieve Application in this same Chrome with the Application ID. A different network often helps.'

let stopRequested = false

export function requestStop() {
  stopRequested = true
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function isCaptchaLandingHref(href) {
  const url = String(href || '').toLowerCase()
  if (/default\.aspx/i.test(url)) return true
  try {
    return /\/genniv\/?$/.test(new URL(href, 'https://ceac.state.gov').pathname.toLowerCase())
  } catch {
    return /\/genniv\/?(\?|#|$)/i.test(url)
  }
}

function looksLikeHardBlock(snap) {
  const blob = `${snap?.title || ''}\n${snap?.heading || ''}\n${snap?.bodyText || ''}\n${snap?.href || ''}`.toLowerCase()
  return (
    blob.includes('sorry, you have been blocked') ||
    blob.includes('you are unable to access') ||
    (blob.includes('attention required') && blob.includes('cloudflare'))
  )
}

function looksLikeServiceUnavailable(snap) {
  const href = String(snap?.href || '')
  const blob = `${snap?.title || ''}\n${snap?.heading || ''}\n${snap?.bodyText || ''}`
  return /identix\.state\.gov/i.test(href) && /503|service unavailable/i.test(`${href}\n${blob}`)
}

const SERVICE_UNAVAILABLE_NOTE =
  'CEAC/identix returned HTTP 503 Service Unavailable. Open Retrieve an Application in this Chrome with the Application ID, then click Fill again.'

function looksLikeCloudflare(snap) {
  if (looksLikeHardBlock(snap)) return false
  const blob = `${snap?.title || ''}\n${snap?.heading || ''}\n${snap?.bodyText || ''}`.toLowerCase()
  return blob.includes('just a moment') || blob.includes('verify you are human')
}

async function peekPage(tabId) {
  const rows = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        href: location.href,
        title: document.title || '',
        heading: (document.querySelector('h1, h2')?.innerText || '').replace(/\s+/g, ' ').trim(),
        bodyText: (document.body?.innerText || '').slice(0, 800),
      }),
    })
    .catch(() => [])
  return (rows || []).map((row) => row.result).filter(Boolean)
}

async function stopIfBlocked(tabId, extra) {
  const pages = extra ? [extra, ...(await peekPage(tabId).catch(() => []))] : await peekPage(tabId)
  const hit = pages.find(looksLikeHardBlock)
  if (!hit) return null
  stopRequested = true
  return { ok: false, stopped: 'cloudflare_block', note: HARD_BLOCK_NOTE }
}

async function disarmUnload(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true }
  await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    files: ['disarm-unload.js'],
  }).catch(() => {})
}

async function injectAgent(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true }
  await disarmUnload(tabId, frameIds)
  const check = await chrome.scripting
    .executeScript({
      target,
      func: () => Boolean(window.__ds160AgentReady && typeof ds160Handle === 'function'),
    })
    .catch(() => [])
  const missing = (check || []).filter((row) => !row.result).map((row) => row.frameId)
  if (check?.length && !missing.length) return
  const injectTarget = missing.length ? { tabId, frameIds: missing } : target
  await chrome.scripting.executeScript({
    target: injectTarget,
    files: ['collect-page-inventory.js', 'content.js'],
  })
}

async function callAgent(tabId, message, frameIds) {
  await injectAgent(tabId, frameIds)
  const injection = await chrome.scripting.executeScript({
    target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
    func: async (msg) => {
      try {
        if (typeof ds160Handle !== 'function' || typeof collectPageInventory !== 'function') {
          return { error: 'agent missing', href: location.href }
        }
        return await ds160Handle(msg)
      } catch (err) {
        return { error: err.message, href: location.href }
      }
    },
    args: [message],
  })
  return injection || []
}

function isBlankHref(href) {
  const value = String(href || '').trim()
  return !value || value === 'about:blank' || value.startsWith('about:')
}

function frameScore(result) {
  const href = result.href || ''
  if (isBlankHref(href)) return -10000
  const fields = result.inventory?.fields?.length || 0
  const ceac = /ceac\.state\.gov/i.test(href) ? 5000 : 0
  const formUrl = /complete|node=/i.test(href) ? 1000 : 0
  return fields + ceac + formUrl
}

function pickSnapshotFrame(results) {
  const usable = results.filter((r) => r?.result && !r.result.error && !isBlankHref(r.result.href))
  usable.sort((a, b) => frameScore(b.result) - frameScore(a.result))
  if (usable.length) return usable[0]
  const detail = results.map((r) => r?.result?.error).filter(Boolean)[0]
  throw new Error(detail || 'Could not read the DS-160 form in this tab.')
}

export async function snapshot(tabId) {
  const results = await callAgent(tabId, { type: 'snapshot' })
  const frame = pickSnapshotFrame(results)
  return { frameId: frame.frameId, ...frame.result }
}

async function plan(snap, source, autonomous) {
  const res = await fetch(`${BRIDGE}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      href: snap.href,
      heading: snap.heading,
      inventory: snap.inventory,
      source,
      autonomous,
      signedSubmitted: Boolean(snap.signedSubmitted),
      hasSignButton: Boolean(snap.hasSignButton),
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `Bridge ${res.status}`)
  return body
}

async function ocrCaptcha(tabId) {
  const missing =
    'No letter CAPTCHA image on this page. If this is Cloudflare “Verify you are human”, complete that yourself.'
  for (let i = 0; i < 10; i++) {
    const frames = await callAgent(tabId, { type: 'captchaSnapshot' })
    const hit = frames.find((r) => r?.result?.captchaPng)
    if (hit?.result?.captchaPng) {
      const res = await fetch(`${BRIDGE}/ocr-captcha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: hit.result.captchaPng }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Bridge ${res.status}`)
      return body.answer
    }
    await sleep(300)
  }
  throw new Error(missing)
}

async function waitForCloudflare(tabId, report) {
  report('Waiting for Cloudflare — complete it in the tab')
  for (let i = 0; i < 180 && !stopRequested; i++) {
    const blocked = await stopIfBlocked(tabId)
    if (blocked) throw new Error(blocked.note)
    const pages = await peekPage(tabId)
    if (!pages.some(looksLikeCloudflare) && !pages.some(looksLikeHardBlock)) {
      return snapshot(tabId)
    }
    await sleep(2000)
  }
  throw new Error('Still on Cloudflare. Complete “Verify you are human”, then Fill again.')
}

function frameResultOk(result) {
  if (!result || result.error) return false
  const items = result.results
  if (Array.isArray(items)) {
    return items.length > 0 && items.every((item) => item && item.ok !== false)
  }
  return result.ok === true
}

async function execute(tabId, actions, frameId, { allowFail = false } = {}) {
  const frames = await callAgent(
    tabId,
    { type: 'execute', actions },
    frameId != null ? [frameId] : undefined,
  )
  const rows = frames || []
  const results = rows.map((row) => row?.result).filter(Boolean)
  const success = results.find(frameResultOk)
  if (success) return { results: success.results || success, failed: null }
  const failedRow = results
    .flatMap((r) => r?.results || [])
    .find((item) => item && item.ok === false)
  const failed = failedRow || results.find((r) => r?.error)
  const message = failed?.error || failed?.message || (results.length ? 'Action failed' : 'No frames responded')
  if (!allowFail) throw new Error(message)
  return { results, failed: { error: message } }
}

async function tabFrameIds(tabId) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => true,
  })
  return (injection || []).map((row) => row.frameId).filter((id) => id != null)
}

async function executeResilient(tabId, actions, preferredFrameId) {
  const tried = new Set()
  const order = []
  if (preferredFrameId != null) order.push(preferredFrameId)
  const fresh = await snapshot(tabId).catch(() => null)
  if (fresh?.frameId != null) order.push(fresh.frameId)
  const ids = await tabFrameIds(tabId).catch(() => [])
  for (const id of ids) order.push(id)

  let last = { results: [], failed: { error: 'Action failed in all frames' } }
  for (const frameId of order) {
    if (tried.has(frameId)) continue
    tried.add(frameId)
    last = await execute(tabId, actions, frameId, { allowFail: true })
    if (!last.failed) return last
  }
  return last
}

async function clickNavigate(tabId, action, snap, report) {
  const clicks = []
  const text = String(action?.text || action?.label || '').trim()
  if (text) clicks.push({ type: 'click', text })
  if (!/^next$/i.test(text)) clicks.push({ type: 'click', text: 'Next' })
  if (!/^continue$/i.test(text)) clicks.push({ type: 'click', text: 'Continue' })

  const seen = new Set()
  for (const click of clicks) {
    const key = String(click.text || '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const out = await executeResilient(tabId, [click], snap?.frameId)
    if (!out.failed) {
      await waitForChange(tabId, snap)
      return true
    }
  }

  const now = await snapshot(tabId).catch(() => null)
  if (now && snap && pageMoved(snap, now)) {
    report('Page already advanced; continuing')
    return true
  }
  report(`Skip Next (${text || 'Next'}); continuing`)
  return false
}

function mightRevealFields(action) {
  if (!action) return false
  if (action.triggersPostback || action.type === 'wait') return true
  if (action.type === 'selectOption' || action.type === 'radio') return true
  if (action.type === 'click' && !isNavigationClick(action)) return true
  return false
}

function fieldRefs(snap) {
  return new Set((snap.inventory?.fields || []).map((f) => f.ref))
}

function hasNewFieldRefs(prev, next) {
  const prevRefs = fieldRefs(prev)
  for (const ref of fieldRefs(next)) {
    if (!prevRefs.has(ref)) return true
  }
  return false
}

function pageMoved(prev, next) {
  return next.href !== prev.href || next.heading !== prev.heading
}

async function waitForChange(tabId, prev) {
  for (let i = 0; i < 16; i++) {
    await sleep(500)
    const blocked = await stopIfBlocked(tabId)
    if (blocked) throw new Error(blocked.note)
    const snap = await snapshot(tabId).catch(() => null)
    if (!snap) continue
    if (looksLikeHardBlock(snap)) throw new Error(HARD_BLOCK_NOTE)
    if (
      !prev ||
      snap.href !== prev.href ||
      snap.heading !== prev.heading ||
      snap.inventory?.signature !== prev.inventory?.signature
    ) {
      return snap
    }
  }
  return snapshot(tabId).catch(() => prev)
}

/** Wait until postback reveals new controls (e.g. Specify after Purpose of Trip). */
async function waitForNewFields(tabId, prev, ms = REVEAL_WAIT_MS) {
  const prevRefs = fieldRefs(prev)
  const deadline = Date.now() + ms
  let last = prev
  while (Date.now() < deadline && !stopRequested) {
    await sleep(350)
    last = await snapshot(tabId)
    if (looksLikeHardBlock(last)) throw new Error(HARD_BLOCK_NOTE)
    if (last.href !== prev.href || last.heading !== prev.heading) return last
    for (const ref of fieldRefs(last)) {
      if (!prevRefs.has(ref)) return last
    }
  }
  return last
}

async function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function fetchBlankPhotoBase64() {
  const res = await fetch(`${BRIDGE}/blank-photo`)
  if (!res.ok) throw new Error('Could not load the blank test photo from the bridge')
  const buf = new Uint8Array(await res.arrayBuffer())
  if (!buf.length) throw new Error('Blank test photo from the bridge was empty')
  return bytesToBase64(buf)
}

async function findFileInputTarget(tabId) {
  const frames = await callAgent(tabId, { type: 'hasFileInput' }).catch(() => [])
  const hit = (frames || []).find((row) => row?.result?.ok)
  if (!hit) return null
  return { tabId, frameId: hit.frameId }
}

async function waitForPhotoTool(originTabId, report) {
  for (let i = 0; i < 40 && !stopRequested; i++) {
    const here = await findFileInputTarget(originTabId)
    if (here) return here
    const tabs = await chrome.tabs.query({
      url: ['https://ceac.state.gov/*', 'https://*.state.gov/*'],
    }).catch(() => [])
    for (const tab of tabs || []) {
      if (tab.id == null || tab.id === originTabId) continue
      const found = await findFileInputTarget(tab.id).catch(() => null)
      if (found) {
        report('Photo tool opened in another tab')
        return found
      }
    }
    await sleep(500)
  }
  throw new Error(
    'Photo tool file input did not appear. Click Upload Your Photo if needed, then Fill again.',
  )
}

async function pageHasSelector(tabId, selector) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (sel) => Boolean(document.querySelector(sel)),
    args: [selector],
  }).catch(() => [])
  return (injection || []).some((row) => row.result)
}

function isConfirmPhotoSnap(snap) {
  const href = String(snap?.href || '').toLowerCase()
  const heading = String(snap?.heading || '').toLowerCase()
  return /confirmphoto/i.test(href) || /confirm photo/i.test(heading)
}

async function runPhotoUpload(tabId, report) {
  let snap = await snapshot(tabId)
  if (isConfirmPhotoSnap(snap)) {
    report('Confirm Photo — clicking Next')
    await clickNavigate(tabId, { type: 'click', text: 'Next' }, snap, report)
    return
  }

  if (await pageHasSelector(tabId, 'input[id$="btnNoImage"]')) {
    report('Photo rejected — Continue Without a Photo')
    await executeResilient(tabId, [{ type: 'click', text: 'Continue Without a Photo' }], snap.frameId)
    await waitForChange(tabId, snap)
    return
  }

  if (!(await findFileInputTarget(tabId))) {
    report('Clicking Upload Your Photo')
    const clicked = await executeResilient(
      tabId,
      [{ type: 'click', text: 'Upload Your Photo' }],
      snap.frameId,
    )
    if (clicked.failed) throw new Error(clicked.failed.error || 'Could not click Upload Your Photo')
  }

  const target = await waitForPhotoTool(tabId, report)
  const imageBase64 = await fetchBlankPhotoBase64()
  report('Attaching blank test JPEG')
  await execute(target.tabId, [{ type: 'uploadPhoto', imageBase64 }], target.frameId)
  await sleep(1200)
  await execute(target.tabId, [{ type: 'click', text: 'Upload' }], target.frameId, { allowFail: true })
  await execute(target.tabId, [{ type: 'click', text: 'Continue' }], target.frameId, { allowFail: true })

  for (let i = 0; i < 40 && !stopRequested; i++) {
    await sleep(700)
    const now = await snapshot(tabId)
    if (looksLikeHardBlock(now)) throw new Error(HARD_BLOCK_NOTE)
    if (isConfirmPhotoSnap(now)) return
    if (await pageHasSelector(tabId, 'input[id$="btnNoImage"]')) {
      report('Photo rejected — Continue Without a Photo')
      await executeResilient(tabId, [{ type: 'click', text: 'Continue Without a Photo' }], now.frameId)
      return
    }
    if (target.tabId !== tabId && (await pageHasSelector(target.tabId, 'input[id$="btnNoImage"]'))) {
      report('Photo rejected — Continue Without a Photo')
      await executeResilient(target.tabId, [{ type: 'click', text: 'Continue Without a Photo' }], target.frameId)
      return
    }
    if (!/\/photo\//i.test(now.href || '') && !/uploadphoto/i.test(now.href || '')) return
  }
  throw new Error(
    'Photo tool did not return to Confirm Photo. Continue Without a Photo if shown, then Fill again.',
  )
}

async function printTabPdf(tabId) {
  const target = { tabId }
  try {
    await chrome.debugger.attach(target, '1.3')
  } catch (err) {
    if (!/already attached/i.test(String(err.message || err))) throw err
  }
  try {
    await chrome.debugger.sendCommand(target, 'Page.enable').catch(() => {})
    const result = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.39,
      marginBottom: 0.39,
      marginLeft: 0.39,
      marginRight: 0.39,
    })
    if (!result?.data) throw new Error('Chrome did not return PDF data')
    return result.data
  } finally {
    await chrome.debugger.detach(target).catch(() => {})
  }
}

async function saveDs160Pdfs(tabId, formId, report) {
  if (!formId) throw new Error('Missing DS160_FORM_ID in the applicant file')
  report('Saving confirmation PDF')
  await sleep(800)
  const confirmationPdf = await printTabPdf(tabId)
  const snap = await snapshot(tabId)
  report('Clicking Print Application')
  const clicked = await executeResilient(tabId, [{ type: 'click', text: 'Print Application' }], snap.frameId)
  if (clicked.failed) throw new Error(clicked.failed.error || 'Could not click Print Application')
  let opened = false
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const now = await snapshot(tabId).catch(() => null)
    if (!now) continue
    if (!now.hasPrintApplication && (now.href !== snap.href || now.heading !== snap.heading)) {
      opened = true
      break
    }
  }
  if (!opened) {
    throw new Error('Print Application was clicked, but CEAC remained on the confirmation page.')
  }
  await sleep(1500)
  report('Saving full application PDF')
  const applicationPdf = await printTabPdf(tabId)
  const res = await fetch(`${BRIDGE}/save-pdfs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formId, confirmationPdf, applicationPdf }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Bridge ${res.status}`)
  report(
    body.uploaded
      ? `Saved confirmation + application PDFs to S3 (${body.confirmationKey || body.confirmationPath})`
      : `Saved PDFs locally (${body.confirmationPath}). S3 upload skipped.`,
  )
  return body
}

async function visibleCaptchaValue(tabId) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const el = document.querySelector(
        '#ctl00_SiteContentPlaceHolder_CodeTextBox, input[type="text"][id$="CodeTextBox"], input[type="text"][id*="txtcaptcha" i]',
      )
      if (!el || el.type === 'hidden') return ''
      return String(el.value || '').trim()
    },
  }).catch(() => [])
  return (injection || []).map((row) => row.result).find(Boolean) || ''
}

function passportFromSource(source) {
  return String(source || '').match(/Passport Number:\s*([A-Za-z0-9]+)/i)?.[1]?.trim() || ''
}

function actionFlag(out, name) {
  return (Array.isArray(out?.results) ? out.results : []).some((row) => row?.[name])
}

async function captchaSrc(tabId) {
  const frames = await callAgent(tabId, { type: 'captchaSnapshot' })
  return (frames || []).map((row) => row?.result?.captchaSrc).find(Boolean) || ''
}

async function refreshLetterCaptcha(tabId, frameId) {
  const before = await captchaSrc(tabId)
  const out = await executeResilient(tabId, [{ type: 'refreshCaptcha' }], frameId)
  if (out.failed) return false
  for (let i = 0; i < 16; i++) {
    await sleep(200)
    const now = await captchaSrc(tabId)
    if (now && now !== before) return true
  }
  return true
}

async function ensureJvisaPreparer(tabId, snap, report) {
  report('E-sign: JVisa preparer')
  let out = await executeResilient(tabId, [{ type: 'syncJvisaPreparer' }], snap.frameId)
  if (out.failed) throw new Error(out.failed.error || 'Could not fill JVisa preparer')
  if (actionFlag(out, 'posted')) {
    await waitForChange(tabId, snap)
    await sleep(1200)
    snap = await snapshot(tabId)
    out = await executeResilient(tabId, [{ type: 'syncJvisaPreparer' }], snap.frameId)
    if (out.failed) throw new Error(out.failed.error || 'Could not fill JVisa preparer after Yes')
  }
  return snapshot(tabId)
}

async function runSignSubmit(tabId, source, report) {
  const ppt = passportFromSource(source)
  if (!ppt) throw new Error('No passport number in the applicant file')

  let snap = await snapshot(tabId)
  if (snap.signedSubmitted && !snap.hasSignButton) return snap

  for (let attempt = 1; attempt <= MAX_SIGN_SUBMIT_TRIES && !stopRequested; attempt++) {
    snap = await snapshot(tabId)
    if (snap.signedSubmitted && !snap.hasSignButton) return snap

    try {
      snap = await ensureJvisaPreparer(tabId, snap, report)
    } catch (err) {
      report(`JVisa preparer: ${err.message}`)
      await sleep(1500)
      continue
    }

    const pptFill = await executeResilient(tabId, [{
      type: 'fill',
      ref: 'PPTNumTbx',
      label: 'Passport/Travel Document Number',
      value: ppt,
    }], snap.frameId)
    if (pptFill.failed) {
      report(`Passport fill failed: ${pptFill.failed.error}`)
      await sleep(1500)
      continue
    }
    report(`E-sign: passport ${ppt}`)

    if (shouldRefreshCaptchaBeforeOcr(attempt)) {
      report(`Refreshing letter CAPTCHA before attempt ${attempt}/${MAX_SIGN_SUBMIT_TRIES}`)
      await refreshLetterCaptcha(tabId, snap.frameId)
    }

    let answer = ''
    try {
      answer = await ocrCaptcha(tabId)
    } catch (err) {
      report(`CAPTCHA OCR failed: ${err.message}`)
      await sleep(1200)
      continue
    }
    report(`E-sign CAPTCHA attempt ${attempt}/${MAX_SIGN_SUBMIT_TRIES}: "${answer}"`)
    if (!answer) {
      await refreshLetterCaptcha(tabId, snap.frameId)
      await sleep(1200)
      continue
    }
    const filled = await executeResilient(tabId, [{ type: 'fillCaptcha', value: answer }], snap.frameId)
    if (filled.failed) {
      report(`CAPTCHA fill failed: ${filled.failed.error}`)
      await sleep(1200)
      continue
    }
    report(`CAPTCHA entered as "${answer}"`)
    await sleep(800)

    const ready = await snapshot(tabId)
    report('Clicking Sign and Submit Application')
    const signed = await executeResilient(tabId, [{ type: 'submitApplication' }], ready.frameId)
    if (signed.failed) {
      report(`Sign click failed: ${signed.failed.error}`)
      await sleep(1500)
      continue
    }
    await waitForChange(tabId, ready)
    const after = await snapshot(tabId)
    if (after.signedSubmitted || after.hasPrintApplication || !after.hasSignButton) return after
    report('Still on Sign page after submit — retrying CAPTCHA')
  }

  throw new Error(
    `Sign and Submit did not succeed after ${MAX_SIGN_SUBMIT_TRIES} CAPTCHA attempts. Fill again to keep trying.`,
  )
}

async function runCaptchaAndStart(tabId, report) {
  const startSnap = await snapshot(tabId)
  const frameId = startSnap.frameId
  for (let attempt = 1; attempt <= MAX_CAPTCHA_TRIES && !stopRequested; attempt++) {
    report(`Letter CAPTCHA attempt ${attempt}/${MAX_CAPTCHA_TRIES}`)
    await execute(tabId, [{ type: 'selectEmbassy', value: 'Tel Aviv' }], frameId)
    await sleep(1600)
    if (shouldRefreshCaptchaBeforeOcr(attempt)) {
      report(`Refreshing letter CAPTCHA before attempt ${attempt}/${MAX_CAPTCHA_TRIES}`)
      await refreshLetterCaptcha(tabId, frameId)
    }
    let answer = ''
    try {
      answer = await ocrCaptcha(tabId)
    } catch (err) {
      report(`CAPTCHA OCR failed: ${err.message}`)
      continue
    }
    report(`CAPTCHA read as "${answer}"`)
    if (!answer) {
      report('CAPTCHA OCR returned empty — retrying')
      await refreshLetterCaptcha(tabId, frameId)
      continue
    }
    await execute(tabId, [{ type: 'fillCaptcha', value: answer }], frameId)
    report('Waiting 2s after CAPTCHA before Start an Application')
    await sleep(2000)
    await execute(tabId, [{ type: 'click', text: 'START AN APPLICATION' }], frameId)
    for (let i = 0; i < 20 && !stopRequested; i++) {
      await sleep(700)
      const next = await snapshot(tabId)
      if (looksLikeHardBlock(next)) throw new Error(HARD_BLOCK_NOTE)
      if (looksLikeCloudflare(next)) {
        const cleared = await waitForCloudflare(tabId, report)
        if (!isCaptchaLandingHref(cleared.href)) return cleared
        break
      }
      if (!isCaptchaLandingHref(next.href)) return next
    }
    report(`Still on start page after CAPTCHA "${answer}" — retrying`)
  }
  throw new Error('Could not leave the start page after CAPTCHA. Check the code and click Start if needed.')
}

export async function runAutofill(tabId, source, report = () => {}) {
  stopRequested = false
  const history = []
  let lastKey = ''
  let stuck = 0

  const blockedAtStart = await stopIfBlocked(tabId)
  if (blockedAtStart) return blockedAtStart

  for (let step = 1; step <= MAX_PAGES && !stopRequested; step++) {
    let planned = null
    try {
      const blocked = await stopIfBlocked(tabId)
      if (blocked) return { ...blocked, history }

      let snap = await snapshot(tabId)
      if (looksLikeHardBlock(snap)) {
        stopRequested = true
        return { ok: false, stopped: 'cloudflare_block', note: HARD_BLOCK_NOTE, history }
      }
      if (looksLikeServiceUnavailable(snap)) {
        return { ok: false, stopped: 'service_unavailable', note: SERVICE_UNAVAILABLE_NOTE, history }
      }
      if (looksLikeCloudflare(snap)) {
        snap = await waitForCloudflare(tabId, report)
      }

      planned = await plan(snap, source, true)
      const line = {
        step,
        pageContext: planned.pageContext,
        source: planned.source,
        href: snap.href,
        heading: snap.heading,
        planned: (planned.actions || []).length,
      }
      history.push(line)
      report(`Step ${step}: ${planned.pageContext} (${planned.source})`, { history, current: line })

      if (planned.stop) {
        return { ok: true, stopped: planned.pageContext, note: planned.note, history }
      }

      const key = `${planned.pageContext}|${snap.href}|${snap.inventory?.signature || ''}`
      if (key === lastKey) {
        stuck += 1
      } else {
        stuck = 0
        lastKey = key
      }
      const forceNext = shouldForceNextWhenStuck(stuck, {
        pageContext: planned.pageContext,
        href: snap.href,
      })

      if (planned.pageContext === 'captcha' || (planned.pageContext === 'unknown' && isCaptchaLandingHref(snap.href))) {
        await runCaptchaAndStart(tabId, report)
        continue
      }

      if (planned.pageContext === 'signed') {
        if (snap.hasSignButton && !snap.signedSubmitted) {
          await runSignSubmit(tabId, source, report)
          continue
        }
        if (shouldGiveUpWhenStuck(stuck)) {
          return {
            ok: false,
            note: 'Stuck on the signed page — Next: Confirmation did not advance.',
            history,
          }
        }
        report('Signed — clicking Next: Confirmation')
        await clickNavigate(tabId, { type: 'click', text: 'Next: Confirmation' }, snap, report)
        continue
      }

      if (planned.pageContext === 'confirmation' || snap.hasPrintApplication) {
        await saveDs160Pdfs(tabId, planned.formId, report)
        return {
          ok: true,
          stopped: 'confirmation',
          note: 'Saved confirmation and application PDFs.',
          history,
        }
      }

      if (planned.pageContext === 'photo') {
        await runPhotoUpload(tabId, report)
        continue
      }

      if (planned.pageContext === 'sign_submit') {
        await runSignSubmit(tabId, source, report)
        continue
      }

      const resolved = []
      for (const action of planned.actions || []) {
        if (action.type === 'done') continue
        if (action.type === 'solveCaptcha') {
          const existing = await visibleCaptchaValue(tabId)
          if (/^[A-Za-z0-9]{2,10}$/.test(existing)) {
            report(`CAPTCHA already filled (${existing})`)
            continue
          }
          const answer = await ocrCaptcha(tabId)
          if (!answer) {
            report('CAPTCHA OCR returned empty — not clearing the field')
            continue
          }
          resolved.push({ type: 'fillCaptcha', value: answer })
        } else {
          resolved.push(action)
        }
      }

      const fields = resolved.filter(isFieldAction)
      const nav = resolved.filter(isNavigationClick)
      const realFields = fields.filter((action) => action.type !== 'wait')

      if (realFields.length && !forceNext) {
        let page = snap
        let revealed = false
        for (const action of fields) {
          await sleep(FIELD_PAUSE_MS)
          const out = await executeResilient(tabId, [action], page.frameId)
          if (out.failed) {
            report(`Skip ${action.type}: ${out.failed.error}`)
            continue
          }
          if (!mightRevealFields(action)) continue
          const waitMs = action.type === 'wait' ? 2000 : REVEAL_WAIT_MS
          const next = await waitForNewFields(tabId, page, waitMs)
          if (looksLikeHardBlock(next)) {
            stopRequested = true
            return { ok: false, stopped: 'cloudflare_block', note: HARD_BLOCK_NOTE, history }
          }
          if (pageMoved(page, next) || hasNewFieldRefs(page, next)) {
            revealed = true
            page = next
            break
          }
          page = next
        }
        if (revealed) continue
        if (nav.length) {
          await sleep(NAV_PAUSE_MS)
          await clickNavigate(tabId, nav[0], snap, report)
        }
        continue
      }

      if (nav.length || forceNext) {
        if (forceNext) report(`Stuck on ${planned.pageContext} — clicking Next`)
        await sleep(NAV_PAUSE_MS)
        await clickNavigate(tabId, nav[0] || { type: 'click', text: 'Next' }, snap, report)
        if (shouldGiveUpWhenStuck(stuck)) {
          const now = await snapshot(tabId).catch(() => null)
          if (now && pageMoved(snap, now)) {
            stuck = 0
            continue
          }
          return {
            ok: false,
            note: `Stuck on ${planned.pageContext} after clicking Next ${stuck} times.`,
            history,
          }
        }
        continue
      }

      if (planned.readyForNext === false || (planned.unresolvedRequired || []).length > 0) {
        report(
          `Not clicking Next yet (${(planned.unresolvedRequired || []).length} required field(s) still open)`,
        )
        continue
      }

      await sleep(NAV_PAUSE_MS)
      await clickNavigate(tabId, { type: 'click', text: 'Next' }, snap, report)
    } catch (err) {
      const message = String(err.message || err)
      if (message.includes('cannot unblock') || /sorry, you have been blocked/i.test(message)) {
        return { ok: false, stopped: 'cloudflare_block', note: HARD_BLOCK_NOTE, history }
      }
      if (planned?.pageContext === 'sign_submit' || planned?.pageContext === 'signed') {
        return { ok: false, stopped: planned.pageContext, note: message, history }
      }
      report(`Skip step error: ${message}`)
      await sleep(800)
    }
  }

  if (stopRequested) return { ok: true, stopped: 'stopped', note: 'Stopped.', history }
  return { ok: false, note: `Stopped after ${MAX_PAGES} pages.`, history }
}

export async function planOnePage(tabId, source) {
  const snap = await snapshot(tabId)
  const planned = await plan(snap, source, false)
  return { snap, planned }
}
