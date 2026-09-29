/**
 * DS-160 Vision Agent
 *
 * At each step:
 *   1. Screenshot the current page
 *   2. Send screenshot + applicant data + action history to the configured model
 *   3. The model returns ONE structured action
 *   4. Execute the action with Playwright
 *   5. Wait for the page to settle, then repeat
 *
 * The run is complete only after Sign and Submit and the confirmation PDFs
 * are saved. Generic clicks on "Sign and Submit Application" are blocked;
 * the guarded submitApplication action performs the real submit.
 */

import { spawnSync } from 'node:child_process'
import { createCanvas } from '@napi-rs/canvas'
import { OPENAI_MODELS } from '../lib/openaiModels.js'
import { normalizeCeacNameFillValue } from '../lib/ceacNameFormatting.js'
import {
  fitDs160Phone,
  fitDs160Value,
  isTranslatedCityLabel,
  limitForTranslatedLabel,
} from '../lib/ds160CityLength.js'
import { normalizePhoneFillValue, phoneDigits } from '../lib/phoneFormatting.js'
import {
  detectPageContextFromHeading,
  detectPageContextFromUrl,
  detectPageContextFromUrlFallback,
  pageIsAfterPersonal1,
} from './detect-page-context.js'
import { UNKNOWN_US_STAY_ZIP } from './parse-applicant-source.js'
import { splitUsStayAddress } from '../lib/usStayAddress.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_TIMEOUT_MS = 60_000

export function createBlankTestPhoto() {
  // Meets the DS-160 file-level constraints used by the photo tool:
  // square JPEG, 600×600 pixels, and comfortably below 240 KB.
  // It deliberately contains no applicant image and will not pass face checks.
  const canvas = createCanvas(600, 600)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 600, 600)
  return canvas.toBuffer('image/jpeg')
}

/** fetch with a hard timeout so a slow OpenAI response never hangs forever */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Phrases that indicate a final-submission button — always blocked
const SUBMIT_BLOCKLIST = [
  'sign and submit',
  'submit application',
  'submit this application',
  'final submit',
  'submit now',
]

export function isBlockedSubmissionClick(action = {}) {
  if (action.type !== 'click' || !action.text) return false

  const text = String(action.text).trim()
  // This button only opens the Sign and Submit page. Final submission is
  // performed later through the guarded submitApplication action.
  if (/^next\s*:\s*sign and submit$/i.test(text)) return false

  const lower = text.toLowerCase()
  return SUBMIT_BLOCKLIST.some((blocked) => lower.includes(blocked))
}

// ─── Logging helpers ────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
}

export function log(msg) {
  console.log(`[${ts()}] ${msg}`)
}

export function logSection(name) {
  const bar = '─'.repeat(60)
  console.log(`\n${bar}`)
  console.log(`[${ts()}] 📋 SECTION → ${name}`)
  console.log(bar)
}

export function logAction(action) {
  const parts = [`[${ts()}] ▶ ${action.type}`]
  if (action.label) parts.push(`label="${action.label}"`)
  if (action.text) parts.push(`text="${action.text}"`)
  if (action.value) parts.push(`value="${String(action.value).slice(0, 60)}"`)
  console.log(parts.join('  '))
}

export function logError(msg, err) {
  console.error(`[${ts()}] ❌ ${msg}`, err?.message || err || '')
}

export function logWarn(msg) {
  console.warn(`[${ts()}] ⚠️  ${msg}`)
}

// ─── CAPTCHA solver ──────────────────────────────────────────────────────────

const CLOUDFLARE_POLL_MS = 2000
const CLOUDFLARE_CLEAR_POLLS = 3

/**
 * Cloudflare Turnstile is a browser attestation widget, not a character CAPTCHA.
 * Vision models cannot mint a cf-turnstile token. Detect it from page signals.
 */
export function isCloudflareHardBlockSignals({ title = '', html = '' } = {}) {
  const blob = `${title}\n${html}`.toLowerCase()
  return (
    blob.includes('sorry, you have been blocked') ||
    blob.includes('you are unable to access ceac') ||
    /attention required/i.test(String(title))
  )
}

/**
 * Real DS-160 pages still load Cloudflare Turnstile JS / hidden iframes.
 * Those are not an interstitial if the CEAC form chrome is already visible.
 */
const CEAC_FORM_CHROME_RE =
  /application id|ctl00_sitecontentplaceholder|consular electronic application center|captchaimage|txtcaptcha|txtcodetextbox|lnknew|btnnewapp|uclocationsearch_ddllocation|start an application/i

export const CEAC_VISIBLE_CONTROLS_SELECTOR = [
  'select[id$="ddlLocation"]',
  'img.LBD_CaptchaImage',
  'img[id$="CaptchaImage"]',
  'input[id*="txtCodeTextBox"]',
  'input[id*="txtcaptcha" i]',
  'a[id$="lnkNew"]',
  'input[id*="btnNewApp"]',
].join(', ')

export function looksLikeCeacApplicationChrome({ title = '', html = '', url = '' } = {}) {
  if (isCloudflareHardBlockSignals({ title, html, url })) return false
  const href = String(url || '')
  if (/__cf_chl|cdn-cgi\/challenge/i.test(href)) return false
  const blob = `${title}\n${html}`
  if (CEAC_FORM_CHROME_RE.test(blob)) return true
  if (/just a moment/i.test(String(title))) return false
  return /ceac\.state\.gov/i.test(href) && /\/genniv\//i.test(href) && /\.aspx/i.test(href)
}

export function isCloudflareChallengeSignals({ title = '', html = '', url = '' } = {}) {
  if (isCloudflareHardBlockSignals({ title, html, url })) return true
  if (looksLikeCeacApplicationChrome({ title, html, url })) return false
  const titleText = String(title)
  const blob = `${title}\n${html}\n${url}`.toLowerCase()
  return (
    /just a moment/i.test(titleText) ||
    blob.includes('__cf_chl') ||
    blob.includes('challenges.cloudflare.com') ||
    blob.includes('cf-turnstile') ||
    blob.includes('cdn-cgi/challenge') ||
    blob.includes('performing security verification') ||
    blob.includes('verify you are human') ||
    (blob.includes('just a moment') && blob.includes('cloudflare'))
  )
}

export function isInteractiveBrowserSession() {
  return process.env.DS160_HEADED === '1' || Boolean(process.env.DS160_CDP_URL?.trim())
}

export const CLOUDFLARE_HEADLESS_PREFIX = 'CLOUDFLARE_HEADLESS'
export const CEAC_SERVICE_UNAVAILABLE_PREFIX = 'CEAC_SERVICE_UNAVAILABLE'

const HEADLESS_TURNSTILE_ERROR =
  `${CLOUDFLARE_HEADLESS_PREFIX}: CEAC Cloudflare cannot be completed in a new headless browser. ` +
  'Pass the check in Chrome, start it with --remote-debugging-port=9222, then rerun autofill so it attaches to that window.'

export function isFatalCloudflareError(err) {
  return String(err?.message || err || '').includes(CLOUDFLARE_HEADLESS_PREFIX)
}

export function isCeacServiceUnavailableSignals({ title = '', html = '', url = '' } = {}) {
  const href = String(url || '').toLowerCase()
  const titleText = String(title || '')
  const blob = `${title}\n${html}`.toLowerCase()
  const unavailable =
    /service unavailable/i.test(titleText) ||
    blob.includes('http error 503') ||
    blob.includes('the service is unavailable') ||
    (/\b503\b/.test(blob) && blob.includes('unavailable'))
  if (!unavailable) return false
  return (
    href.includes('identix.state.gov') ||
    href.includes('ceac.state.gov') ||
    href.includes('state.gov') ||
    blob.includes('identix')
  )
}

export function isCeacServiceUnavailableError(err) {
  const message = String(err?.message || err || '')
  if (message.includes(CEAC_SERVICE_UNAVAILABLE_PREFIX)) return true
  return /identix\.state\.gov/i.test(message) && /503|service unavailable/i.test(message)
}

export function ceacServiceUnavailableError() {
  return new Error(
    `${CEAC_SERVICE_UNAVAILABLE_PREFIX}: identix/CEAC returned HTTP 503 Service Unavailable. ` +
      'Autofill will reopen and retrieve the application.',
  )
}

export async function pageLooksLikeCeacServiceUnavailable(page) {
  try {
    if (!page || page.isClosed()) return false
    const url = page.url()
    const title = await page.title().catch(() => '')
    const bodyText = await page.locator('body').innerText({ timeout: 800 }).catch(() => '')
    const html = await page.content().catch(() => '')
    return isCeacServiceUnavailableSignals({
      title,
      html: `${html}\n${bodyText}`,
      url,
    })
  } catch {
    return false
  }
}

export async function throwIfCeacServiceUnavailable(page) {
  if (await pageLooksLikeCeacServiceUnavailable(page)) {
    throw ceacServiceUnavailableError()
  }
}

async function pageCloudflareSignals(page) {
  const title = await page.title().catch(() => '')
  const html = await page.content().catch(() => '')
  const url = page.url()
  const bodyText = await page.locator('body').innerText({ timeout: 800 }).catch(() => '')
  return { title, html: `${html}\n${bodyText}`, url }
}

export async function pageLooksLikeCloudflareHardBlock(page) {
  try {
    return isCloudflareHardBlockSignals(await pageCloudflareSignals(page))
  } catch {
    return false
  }
}

export async function pageHasVisibleCeacControls(page) {
  try {
    return await page.locator(CEAC_VISIBLE_CONTROLS_SELECTOR).first().isVisible({ timeout: 500 })
  } catch {
    return false
  }
}

export async function pageLooksLikeCloudflareChallenge(page) {
  try {
    if (await pageHasVisibleCeacControls(page)) return false
    const signals = await pageCloudflareSignals(page)
    if (isCloudflareChallengeSignals(signals)) return true
    if (looksLikeCeacApplicationChrome(signals)) return false
    return page.frames().some((frame) => {
      const frameUrl = String(frame.url() || '').toLowerCase()
      return frameUrl.includes('challenges.cloudflare.com') || frameUrl.includes('cf-turnstile')
    })
  } catch {
    return false
  }
}

export async function waitForHumanBotVerification(page) {
  let sawChallenge = false
  let lastLog = 0
  let clearStreak = 0

  while (true) {
    await throwIfCeacServiceUnavailable(page)
    const showing = await pageLooksLikeCloudflareChallenge(page)
    if (showing) {
      if (!isInteractiveBrowserSession()) {
        throw new Error(HEADLESS_TURNSTILE_ERROR)
      }
      if (!sawChallenge) {
        sawChallenge = true
        log(
          'Cloudflare is showing a security page. Complete it in this Chrome window ' +
          '(click each "Verify you are human" if asked). Autofill waits until CEAC is back.',
        )
        if (process.platform === 'darwin') {
          spawnSync('osascript', [
            '-e',
            'display notification "Click Verify you are human in the DS-160 Chrome window." with title "DS-160 Fill"',
          ], { stdio: 'ignore' })
          spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate'], { stdio: 'ignore' })
        }
      } else if (clearStreak > 0) {
        log('Cloudflare security page appeared again — waiting for another pass.')
      }
      clearStreak = 0
      if (Date.now() - lastLog > 15_000) {
        lastLog = Date.now()
        log('Still waiting for Cloudflare security page to clear…')
      }
      await page.waitForTimeout(CLOUDFLARE_POLL_MS)
      continue
    }

    if (!sawChallenge) return false

    clearStreak++
    if (clearStreak < CLOUDFLARE_CLEAR_POLLS) {
      await page.waitForTimeout(CLOUDFLARE_POLL_MS)
      continue
    }

    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForTimeout(500)
    if (await pageLooksLikeCloudflareChallenge(page)) {
      clearStreak = 0
      continue
    }

    log('Cloudflare verification cleared — continuing autofill.')
    return true
  }
}

/** CEAC landing “START AN APPLICATION” — never match instruction copy. */
export const START_APPLICATION_SELECTOR = [
  '#ctl00_SiteContentPlaceHolder_lnkNew',
  'a[id$="lnkNew"]',
  'a[id*="lnkNew"]',
  '#ctl00_SiteContentPlaceHolder_ucLocationSearch_btnNewApp',
  'input[id*="btnNewApp"]',
  'a[id*="btnNewApp"]',
  'button[id*="btnNewApp"]',
  'input[type="image"][id*="NewApp" i]',
  'input[type="submit"][value*="START AN APPLICATION" i]',
  'input[type="button"][value*="START AN APPLICATION" i]',
  'input[type="image"][alt*="START AN APPLICATION" i]',
  'input[title*="START AN APPLICATION" i]',
].join(', ')

/**
 * CEAC sets window.needToConfirm and onbeforeunload so every real navigation
 * shows Chrome's "Leave site?" dialog. Freeze that flag and swallow the event.
 * Runs in the page (and as an init script so it survives postbacks).
 */
export function disarmCeacUnloadInPage() {
  const silence = () => {
    try { window.needToConfirm = false } catch { /* ignore */ }
    try { window.onbeforeunload = null } catch { /* ignore */ }
    try { window.onunload = null } catch { /* ignore */ }
    try { window.confirmExit = function confirmExit() {} } catch { /* ignore */ }
    try {
      // CEAC setDirty marks the form changed so repeater "Add Another" postbacks
      // keep the row just typed. Do not no-op it — that left languages/countries
      // at a single row. Keep needToConfirm false after the original runs.
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
      const wrapped = function wrappedDoPostBack() {
        try { window.needToConfirm = false } catch { /* ignore */ }
        return original.apply(this, arguments)
      }
      wrapped.__ds160Wrapped = true
      window.__doPostBack = wrapped
    }
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
}

/** Click Cancel: Stay on Page if CEAC thinks we are leaving the application. */
export async function dismissCeacLeavePageDialog(page) {
  if (!page || page.isClosed()) return false
  const panel = page.locator('#ctl00_pnlExitWarning')
  const visible = await panel.isVisible({ timeout: 250 }).catch(() => false)
  if (!visible) return false
  const stay = page.locator(
    '#ctl00_btnCancelExitWarning, input[id$="btnCancelExitWarning"], input[value*="Stay on Page" i]',
  ).first()
  if (!await stay.isVisible({ timeout: 800 }).catch(() => false)) return false
  log('CEAC "leaving the application" dialog — staying on the page')
  await stay.click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(400).catch(() => {})
  return true
}

async function suppressBrowserAutofill(locator) {
  await locator.evaluate((node) => {
    node.setAttribute('autocomplete', 'off')
    node.setAttribute('autocorrect', 'off')
    node.setAttribute('autocapitalize', 'off')
    node.setAttribute('spellcheck', 'false')
    node.setAttribute('data-lpignore', 'true')
  }).catch(() => {})
}

async function waitUntilInputEnabled(page, locator, timeout = 10_000) {
  const handle = await locator.elementHandle()
  if (!handle) return false
  return page.waitForFunction(
    (element) => element instanceof HTMLInputElement && !element.disabled,
    handle,
    { timeout },
  ).then(() => true).catch(() => false)
}

export async function disarmCeacUnload(page) {
  if (!page || page.isClosed()) return
  try {
    await page.addInitScript(disarmCeacUnloadInPage)
  } catch { /* already closed or script already added */ }
  await page.evaluate(disarmCeacUnloadInPage).catch(() => {})
  if (!page.__ds160DialogHooked) {
    page.__ds160DialogHooked = true
    page.on('dialog', async (dialog) => {
      try { await dialog.accept() } catch { /* already gone */ }
    })
  }
  if (page.__ds160CdpDialogs) return
  page.__ds160CdpDialogs = true
  try {
    const session = await page.context().newCDPSession(page)
    await session.send('Page.enable')
    session.on('javascriptDialogOpening', async () => {
      try {
        await session.send('Page.handleJavaScriptDialog', { accept: true })
      } catch { /* dialog already closed */ }
    })
  } catch { /* CDP unavailable (tests / closed context) */ }
}

function activateStartApplicationInPage() {
  const el = document.querySelector(
    [
      '#ctl00_SiteContentPlaceHolder_lnkNew',
      'a[id$="lnkNew"]',
      'a[id*="lnkNew"]',
      '#ctl00_SiteContentPlaceHolder_ucLocationSearch_btnNewApp',
      'input[id*="btnNewApp"]',
      'a[id*="btnNewApp"]',
      'button[id*="btnNewApp"]',
      'input[type="image"][id*="NewApp" i]',
      'input[type="submit"][value*="START AN APPLICATION" i]',
      'input[type="button"][value*="START AN APPLICATION" i]',
    ].join(', '),
  ) || [...document.querySelectorAll('a[role="Button"], a[role="button"], input[type="submit"], button')].find((node) =>
    /start an application/i.test(`${node.textContent || ''} ${node.value || ''} ${node.alt || ''}`),
  )
  if (!el) return { ok: false, reason: 'missing' }

  el.removeAttribute('disabled')
  el.disabled = false
  try { window.needToConfirm = false } catch { /* ignore */ }

  const href = el.getAttribute('href') || ''
  const postback = href.match(/__doPostBack\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/)
  if (postback && typeof window.__doPostBack === 'function') {
    window.__doPostBack(postback[1], postback[2])
    return { ok: true, how: 'href-postback' }
  }
  const uniqueId = el.getAttribute('name') || String(el.id || '').replace(/_/g, '$')
  if (typeof window.__doPostBack === 'function' && /lnkNew|btnNewApp/i.test(uniqueId)) {
    window.__doPostBack(uniqueId, '')
    return { ok: true, how: 'id-postback' }
  }
  el.click()
  return { ok: true, how: 'click' }
}

/**
 * Click the landing-page Start control by id. CEAC renders it as
 * `<a id="...lnkNew" disabled role="Button">` with no href until enabled —
 * Playwright will not click a disabled control, and getByText hits the
 * instructions. Enable it and invoke the ASP.NET postback.
 */
export async function clickStartApplication(page) {
  await disarmCeacUnload(page)
  log('Waiting 2s after CAPTCHA before Start an Application…')
  await page.waitForTimeout(2000)
  const result = await page.evaluate(activateStartApplicationInPage).catch(() => null)
  if (result?.ok) {
    log(`Clicked Start an Application (${result.how})`)
    return true
  }
  const known = page.locator(START_APPLICATION_SELECTOR).first()
  try {
    await known.click({ force: true, timeout: 4000 })
    log('Clicked Start an Application')
    return true
  } catch {
    return false
  }
}

export async function selectEmbassyOnPage(page, value = 'Tel Aviv') {
  const needle = String(value || 'Tel Aviv')
  const knownIds = [
    '#ctl00_SiteContentPlaceHolder_ucLocationSearch_ddlLocation',
    'select[id$="ddlLocation"]',
    'select[name$="ddlLocation"]',
  ]
  let ddl = null
  for (const sel of knownIds) {
    const el = page.locator(sel).first()
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      ddl = el
      break
    }
  }
  if (!ddl) {
    for (const sel of await page.locator('select').all()) {
      const texts = await sel.locator('option').allTextContents()
      const hasEmbassy = texts.some((t) => new RegExp(needle, 'i').test(t || ''))
      const isLanguage = !hasEmbassy && texts.some((t) => /arabic|hebrew|français|العربية/i.test(t || ''))
      if (isLanguage) continue
      if (hasEmbassy) {
        ddl = sel
        break
      }
    }
  }
  if (!ddl) throw new Error('Embassy location dropdown not found')

  const current = (await ddl.locator('option:checked').textContent().catch(() => '')) || ''
  if (current.toUpperCase().includes(needle.toUpperCase())) {
    log(`Embassy already selected: "${current.trim()}"`)
    return
  }
  const options = await ddl.locator('option').all()
  for (const opt of options) {
    const txt = ((await opt.textContent()) || '').trim()
    if (!txt.toUpperCase().includes(needle.toUpperCase())) continue
    const val = await opt.getAttribute('value')
    if (!val) continue
    await ddl.selectOption(val)
    log(`Embassy selected: "${txt}"`)
    await page.waitForTimeout(1500)
    return
  }
  throw new Error(`Embassy option "${needle}" not found`)
}

/**
 * Crops the CAPTCHA image from the page, sends it to the OCR model, and returns
 * the text. Retries up to maxRetries times if the form rejects the answer.
 */
export async function solveCaptchaOnPage(page, apiKey) {
  if (await pageLooksLikeCloudflareChallenge(page)) {
    await waitForHumanBotVerification(page)
    return ''
  }

  log(`Solving CAPTCHA via model=${OPENAI_MODELS.captcha}…`)

  // Common CAPTCHA image selectors on the DS-160 site
  const captchaSelectors = [
    'img.LBD_CaptchaImage',
    'img[id$="CaptchaImage"]',
    '#ctl00_SiteContentPlaceHolder_ucLocationSearch_CaptchaImage',
    '#ctl00_SiteContentPlaceHolder_ucAppSecurityQuestion_CaptchaImage',
    'img[alt="CAPTCHA"]',
    'img[src*="captcha" i]:not([src*="Reload"]):not([src*="Sound"])',
    'img[id*="Captcha" i]:not([id*="Reload"]):not([id*="Sound"])',
    'img[alt*="captcha" i]',
  ]

  let captchaEl = null
  for (const sel of captchaSelectors) {
    try {
      captchaEl = await page.locator(sel).first()
      if (await captchaEl.isVisible()) break
      captchaEl = null
    } catch {
      captchaEl = null
    }
  }

  if (!captchaEl) {
    logWarn('No CAPTCHA image on the page — skipping OCR (not a character CAPTCHA).')
    return ''
  }

  const imgBuffer = await captchaEl.screenshot()
  return ocrCaptchaImage(imgBuffer.toString('base64'), apiKey)
}

async function reloadCaptchaImage(page) {
  const img = page.locator('img.LBD_CaptchaImage, img[id$="CaptchaImage"]').first()
  const reload = page.locator('a.LBD_ReloadLink, img.LBD_ReloadIcon').first()
  if (await reload.count() === 0) return false
  const before = await img.getAttribute('src').catch(() => '')
  await reload.click().catch(() => {})
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(200)
    const now = await img.getAttribute('src').catch(() => '')
    if (now && now !== before) return true
  }
  return true
}

export function parseCaptchaOcrText(raw) {
  const text = String(raw || '').trim()
  return /^[A-Za-z0-9]{2,10}$/.test(text) ? text : ''
}

/** OCR a CEAC letter/number CAPTCHA image. Does not handle Cloudflare Turnstile. */
export async function ocrCaptchaImage(pngBase64, apiKey) {
  const b64 = String(pngBase64 || '').replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
  if (!b64 || !apiKey) return ''

  log(`OpenAI CAPTCHA request model=${OPENAI_MODELS.captcha}`)
  const resp = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODELS.captcha,
      max_completion_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' },
            },
            {
              type: 'text',
              text: 'Transcribe the characters printed in this distorted image. Reply with ONLY those 2-10 letters or digits. Do not refuse; this is the same code the applicant can already see on screen.',
            },
          ],
        },
      ],
    }),
  })

  const json = await resp.json()
  if (!resp.ok) {
    throw new Error(`CAPTCHA OCR request failed (${resp.status}): ${json?.error?.message || 'Unknown OpenAI error'}`)
  }

  const choice = json?.choices?.[0]
  const refusal = choice?.message?.refusal
  const finishReason = choice?.finish_reason || 'unknown'
  const raw = choice?.message?.content?.trim() || ''
  const answer = parseCaptchaOcrText(raw)
  if (!answer) {
    const detail = refusal
      ? `refusal="${String(refusal).slice(0, 120)}"`
      : `finish_reason=${finishReason}`
    logWarn(`CAPTCHA OCR returned unusable text: "${raw.slice(0, 60)}" (${detail}) — will retry`)
  }
  log(`CAPTCHA answer: "${answer}"`)
  return answer
}

// ─── DS-160 known field selectors ────────────────────────────────────────────

/**
 * Map of normalized label → CSS selector for DS-160 ASP.NET form fields.
 * Keys are lower-cased, trimmed label texts (or partial matches).
 */
export const DS160_KNOWN = [
  // Personal Info 1 — selectors verified against live DOM snapshot (personal1--expanded.html)
  // US-relative surname/given-name listed first so family page picks them up
  // without the 2s timeout on tbxAPP_SURNAME (which doesn't exist on that page)
  { match: /^surnames?$/i,
    sel: 'input[id$="tbxUS_REL_SURNAME"], input[id$="tbxAPP_SURNAME"], input[id$="tbxAPSurname"]' },
  { match: /^given names?$/i,
    sel: 'input[id$="tbxUS_REL_GIVEN_NAME"], input[id$="tbxAPP_GIVEN_NAME"], input[id$="tbxAPGivenName"]' },
  { match: /native alphabet/i,
    sel: 'input[id$="tbxAPP_FULL_NAME_NATIVE"], input[id$="tbxAPFulNamNatAlph"]' },
  { match: /^sex$|^gender$/i,
    sel: 'select[id$="ddlAPP_GENDER"], select[id$="ddlSex"]' },
  { match: /marital status/i,
    sel: 'select[id$="ddlAPP_MARITAL_STATUS"], select[id$="ddlMaritalStatus"]' },
  // Date of Birth split fields
  { match: /^dob day$|^day \*?$/i,        sel: 'input[id$="tbxDOBDay"], select[id$="ddlDOBDay"]' },
  { match: /^dob month$|^month \*?$/i,    sel: 'select[id$="ddlDOBMonth"], input[id$="tbxDOBMonth"]' },
  { match: /^dob year$|^year \*?$/i,      sel: 'input[id$="tbxDOBYear"], select[id$="ddlDOBYear"]' },
  // City / Place of Birth — DS-160 label is "City" on personal1; only match when "birth" context present
  // (bare "City" is intentionally excluded here — it is handled by the travel-city entry below)
  { match: /city.*birth|place.*birth|birth.*city|town.*birth|city.town|^city of birth$/i,
    sel: 'input[id$="tbxAPP_POB_CITY"], input[id*="APP_POB_CITY"], input[id$="tbxPOBCity"], input[id*="POBCity"], input[id*="BirthCity"]' },
  { match: /state.*birth|province.*birth/i,
    sel: 'input[id$="tbxAPP_POB_ST_PROVINCE"], input[id$="tbxPOBSP"], input[id*="POBSP"], input[id*="POB_ST"]' },
  // Country/Region of Birth — label on form is "Country/Region"; actual ID: ddlAPP_POB_CNTRY
  { match: /country.*birth|^country\/region$/i,
    sel: 'select[id$="ddlAPP_POB_CNTRY"], select[id$="ddlPOBCountry"], select[id$="ddlCountry"]' },
  // Personal Info 2 — selectors verified against live DOM snapshot (personal2--expanded.html)
  { match: /country.*origin|nationality/i,
    sel: 'select[id$="ddlAPP_NATL"], select[id*="APP_NATL"], select[id$="ddlCountryOfOrigin"]' },
  { match: /national.*id/i,
    sel: 'input[id$="tbxAPP_NATIONAL_ID"], input[id*="APP_NATIONAL_ID"], input[id$="txtNationalID"], input[id$="tbxNationalID"]' },
  // Previous Work/Education — synthetic labels avoid the repeated bare "City".
  { match: /^employer city$|^previous employer city$/i,
    sel: 'input[id*="tbxEmpCity"], input[id$="tbxEmpCity"]' },
  { match: /^education city$/i,
    sel: 'input[id*="dtlPrevEduc"][id*="tbxSchoolCity"]' },
  // Address and Phone — home address fields
  { match: /^street address(?:\s*\(line 1\))?$|^home street address/i,
    sel: 'input[id$="tbxAPP_ADDR_LN1"], input[id$="tbxStreetAddress1"]' },
  { match: /^street address\s*\(line 2\)|^home street address.*line 2/i,
    sel: 'input[id$="tbxAPP_ADDR_LN2"], input[id$="tbxStreetAddress2"]' },
  { match: /^city$|^home city$/i,
    sel: 'input[id$="tbxAPP_ADDR_CITY"], input[id$="tbxCity"], input[id$="tbxAPP_POB_CITY"]' },
  { match: /^state\/province$|^home state\/province$/i,
    sel: 'input[id$="tbxAPP_ADDR_STATE"]' },
  { match: /^postal zone\/zip code$|^postal(?: zone)?\/?zip code$|^home postal/i,
    sel: 'input[id$="tbxAPP_ADDR_POSTAL_CD"]' },
  { match: /^country(?:\/region)?$|^home country(?:\/region)?$/i,
    sel: 'select[id$="ddlCountry"]' },
  { match: /^mailing street address(?:\s*\(line 1\))?$/i,
    sel: 'input[id$="tbxMAILING_ADDR_LN1"]' },
  { match: /^mailing street address\s*\(line 2\)$/i,
    sel: 'input[id$="tbxMAILING_ADDR_LN2"]' },
  { match: /^mailing city$/i,
    sel: 'input[id$="tbxMAILING_ADDR_CITY"]' },
  { match: /^mailing state\/province$/i,
    sel: 'input[id$="tbxMAILING_ADDR_STATE"]' },
  { match: /^mailing postal zone\/zip code$/i,
    sel: 'input[id$="tbxMAILING_ADDR_POSTAL_CD"]' },
  { match: /^mailing country(?:\/region)?$/i,
    sel: 'select[id$="ddlMailCountry"]' },
  // Travel Info
  { match: /purpose.*trip|^purpose$/i,
    sel: 'select[id*="ddlPurposeOfTrip"], select[id$="ddlVisaClass"]' },
  { match: /^specify$|other.*purpose|visa.*specify/i,
    sel: 'select[id*="ddlOtherPurpose"]' },
  // Arrival date — split dropdowns
  { match: /arrival.*month|month.*arrival/i,
    sel: 'select[id*="ddlTravelMonthOfArrival"], select[id*="ddlArrivalMonth"]' },
  { match: /arrival.*day|day.*arrival/i,
    sel: 'select[id*="ddlTravelDayOfArrival"], input[id*="tbxArrivalDay"]' },
  { match: /arrival.*year|year.*arrival/i,
    sel: 'input[id*="tbxTravelYearOfArrival"], input[id*="tbxArrivalYear"]' },
  { match: /arrival.*date|date.*arrival/i,
    sel: 'input[id$="tbxDateOfArrival"], input[id$="tbxArrivalDate"]' },
  // Length of stay — quantity input + unit dropdown
  { match: /length.*stay.*unit|stay.*unit|duration.*unit/i,
    sel: 'select[id$="ddlTRAVEL_LOS_CD"], select[id*="ddlDurOfStay"], select[id*="ddlLengthOfStayUnit"]' },
  // fill → quantity input; selectOption will hit the unit dropdown via the unit-match above
  { match: /length.*stay|stay.*length|duration.*stay|intended.*stay/i,
    sel: 'input[id$="tbxTRAVEL_LOS"], input[id*="tbxDurOfStay"], input[id$="tbxLengthOfStay"]' },
  // explicit unit dropdown selector (also matched by length.*stay.*unit above)
  { match: /^stay unit$|^los unit$/i,
    sel: 'select[id$="ddlTRAVEL_LOS_CD"]' },
  // Who is paying
  // Travel — US address fields (confirmed from DOM snapshot)
  { match: /street.*address.*line.*1|street.*address.*1|address.*line.*1/i,
    sel: 'input[id$="tbxStreetAddress1"]' },
  { match: /street.*address.*line.*2|street.*address.*2|address.*line.*2/i,
    sel: 'input[id$="tbxStreetAddress2"]' },
  // Bare "City" label on travel page → tbxCity; also matches personal1 "City" (fallback to tbxAPP_POB_CITY via birth-city entry above)
  { match: /^city\s*\*?$|city.*u\.?s\.?|city.*stay|visit.*city/i,
    sel: 'input[id$="tbxCity"], input[id$="tbxAPP_POB_CITY"], input[id*="APP_POB_CITY"]' },
  { match: /^state\s*\*?$|^us.*state$|state.*u\.?s\.?/i,
    sel: 'select[id$="ddlTravelState"]' },
  { match: /zip.*code|postal.*code|^zip\s*\*?$/i,
    sel: 'input[id$="tbxAPP_ADDR_POSTAL_CD"], input[id$="tbZIPCode"], input[id$="tbxZIPCode"], input[id*="ZIPCode"], input[id*="POSTAL"]' },
  // Travel — Arrive/Depart city and flight (specific travel = YES path)
  { match: /arrive.*city|arrival.*city|city.*arrive/i,
    sel: 'input[id$="tbxArriveCity"]' },
  { match: /arrive.*flight|arrival.*flight|flight.*arrive/i,
    sel: 'input[id$="tbxArriveFlight"]' },
  { match: /depart.*city|departure.*city|city.*depart/i,
    sel: 'input[id$="tbxDepartCity"]' },
  { match: /depart.*flight|departure.*flight|flight.*depart/i,
    sel: 'input[id$="tbxDepartFlight"]' },
  // Travel — location to visit in U.S. (specific travel = YES path)
  { match: /location.*visit|visit.*location|place.*visit|specific.*location/i,
    sel: 'input[id*="tbxSPECTRAVEL_LOCATION"]' },
  // Who is paying — main dropdown (label on screen: "Person/Entity Paying for Your Trip")
  { match: /paying.*trip|person.*paying|who.*paying|entity.*paying|^payer$/i,
    sel: 'select[id$="ddlWhoIsPaying"], select[id*="ddlPayer"]' },
  // Relationship to You (payer) — confirmed label text from live DOM
  { match: /relationship.*to you|relationship.*payer|payer.*relation/i,
    sel: 'select[id$="ddlPayerRelationship"], select[id*="ddlPayerRelationship"], select[id*="ddlPayRelationship"]' },
  // Payer sub-fields — id$= anchors use confirmed ASP.NET IDs from live DOM snapshot.
  // id$= (ends-with) is tried first; broad id*= are fallbacks for alternate server-control prefixes.
  { match: /surname.*person.*paying|surnames.*paying|last.*name.*paying|payer.*surname/i,
    sel: 'input[id$="tbxPayerSurname"], input[id*="PayerSurname"], input[id*="Payer"][id*="Sur"]' },
  { match: /given.*name.*person.*paying|given.*names.*paying|first.*name.*paying|payer.*given/i,
    sel: 'input[id$="tbxPayerGivenName"], input[id*="PayerGiven"], input[id*="Payer"][id*="GivName"]' },
  { match: /^name.*person.*paying|name.*paying.*person/i,
    sel: 'input[id$="tbxPayerGivenName"], input[id*="PayerName"], input[id*="Payer"][id*="Name"]' },
  // "Telephone Number" is the on-screen label (a <span>, not a <label>) for the payer phone field.
  // The system prompt instructs GPT to use "Telephone Number of Person Paying for Trip" which also
  // matches the phone.*person.*paying regex.  Both labels resolve here.
  { match: /phone.*person.*paying|phone.*paying|payer.*phone|^telephone number$/i,
    sel: 'input[id$="tbxPayerPhone"], input[id*="PayerPhone"], input[id*="PAYER_PHONE"]' },
  // Payer email — tbxPAYER_EMAIL_ADDR (note ALL-CAPS; id*="PAYER_EMAIL" is case-sensitive match).
  // The input is disabled by default; executeAction unchecks cbxDNAPAYER_EMAIL_ADDR_NA before filling.
  { match: /email.*person.*paying|email.*paying|payer.*email/i,
    sel: 'input[id$="tbxPAYER_EMAIL_ADDR"], input[id*="PAYER_EMAIL"]' },
  { match: /street.*address.*person.*paying|address.*person.*paying|address.*paying|payer.*addr/i,
    sel: 'input[id*="PayerAddr"], input[id*="PAYER_ADDR"], input[id*="PayerStreet"], input[id*="Payer"][id*="Addr"]' },
  // U.S. Point of Contact — confirmed from us_point_of_contact--expanded.html.
  // These must precede the generic Address and Phone selectors below because
  // the visible labels are simply "Phone Number" and "Email Address".
  { match: /point.*contact.*phone|u\.?s\.?.*contact.*phone|^phone number$/i,
    sel: 'input[id$="tbxUS_POC_HOME_TEL"]' },
  { match: /point.*contact.*email|u\.?s\.?.*contact.*email|^email address$/i,
    sel: 'input[id$="tbxUS_POC_EMAIL_ADDR"]' },
  { match: /point.*contact.*organization|u\.?s\.?.*contact.*organization|^organization name$/i,
    sel: 'input[id$="tbxUS_POC_ORGANIZATION"]' },
  // Present Work / Education
  { match: /briefly.*describe.*duties|describe.*(?:your )?duties|^duties$/i,
    sel: 'textarea[id$="tbxDescribeDuties"]' },
  // Address and Phone
  { match: /primary.*phone|home.*phone/i,
    sel: 'input[id$="tbxAPP_HOME_TEL"], input[id$="tbxPhoneNumberHome"]' },
  { match: /secondary.*phone|mobile.*phone/i,
    sel: 'input[id$="tbxAPP_MOBILE_TEL"]' },
  { match: /work.*phone|employer.*phone/i,
    sel: 'input[id$="tbxAPP_BUS_TEL"], input[id$="tbxPhoneNumberWork"]' },
  { match: /^additional phone number$/i,
    sel: 'input[id*="dtlAddPhone"][id*="tbxAddPhoneInfo"]' },
  { match: /^additional email address$/i,
    sel: 'input[id*="dtlAddEmail"][id*="tbxAddEmailInfo"]' },
  { match: /^social media provider\/platform$/i,
    sel: 'select[id*="dtlSocial"][id*="ddlSocialMedia"]' },
  { match: /^social media identifier$/i,
    sel: 'input[id*="dtlSocial"][id*="tbxSocialMediaIdent"]' },
  { match: /^email address$/i,
    sel: 'input[id$="tbxAPP_EMAIL_ADDR"], input[id$="tbxEmailAddr"]' },
  // Previous U.S. Travel
  { match: /^visa number$/i,               sel: 'input[id$="tbxPREV_VISA_FOIL_NUMBER"]' },
  { match: /driver.?s license number/i,    sel: 'input[id*="tbxUS_DRIVER_LICENSE"]' },
  { match: /state of driver.?s license/i,  sel: 'select[id*="ddlUS_DRIVER_LICENSE_STATE"]' },
  { match: /^lost visa year$|year visa was lost/i,
    sel: 'input[id$="tbxPREV_VISA_LOST_YEAR"]' },
  { match: /^lost visa explanation$/i,
    sel: 'textarea[id$="tbxPREV_VISA_LOST_EXPL"]' },
  { match: /^cancelled visa explanation$/i,
    sel: 'textarea[id$="tbxPREV_VISA_CANCELLED_EXPL"]' },
  { match: /^visa refusal explanation$/i,
    sel: 'textarea[id$="tbxPREV_VISA_REFUSED_EXPL"]' },
  { match: /^immigrant petition explanation$/i,
    sel: 'textarea[id$="tbxIV_PETITION_EXPL"]' },
  // Additional Work / Education conditional explanations
  { match: /^specialized skills explanation$/i,
    sel: 'textarea[id$="tbxSPECIALIZED_SKILLS_EXPL"]' },
  { match: /^paramilitary\/insurgent explanation$|^insurgent organization explanation$/i,
    sel: 'textarea[id$="tbxINSURGENT_ORG_EXPL"]' },
  // Passport
  { match: /passport.*document type|passport.*type/i,
    sel: 'select[id$="ddlPPT_TYPE"]' },
  { match: /^passport\/travel document number$|^passport number$/i,
    sel: 'input[id$="tbxPPT_NUM"], input[id$="tbxPassportNumber"]' },
  { match: /passport.*book/i,
    sel: 'input[id$="tbxPPT_BOOK_NUM"], input[id$="tbxPassportBookNumber"]' },
  { match: /^country\/authority that issued passport\/travel document$/i,
    sel: 'select[id$="ddlPPT_ISSUED_CNTRY"]' },
  { match: /^passport issuance city$|^city of issuance$/i,
    sel: 'input[id$="tbxPPT_ISSUED_IN_CITY"], input[id$="tbxPassIssCit"]' },
  { match: /^passport issuance state\/province$|^state\/province of issuance$/i,
    sel: 'input[id$="tbxPPT_ISSUED_IN_STATE"]' },
  { match: /^passport issuance country\/region$/i,
    sel: 'select[id$="ddlPPT_ISSUED_IN_CNTRY"]' },
  { match: /^lost passport\/travel document number$/i,
    sel: 'input[id*="dtlLostPPT"][id*="tbxLOST_PPT_NUM"]' },
  { match: /^lost passport country\/authority$/i,
    sel: 'select[id*="dtlLostPPT"][id*="ddlLOST_PPT_NATL"]' },
  { match: /^lost passport explanation$/i,
    sel: 'textarea[id*="dtlLostPPT"][id*="tbxLOST_PPT_EXPL"]' },
  { match: /issue.*date|date.*issue/i,    sel: 'input[id$="tbxPassIssDt"]' },
  { match: /expir.*date|date.*expir/i,    sel: 'input[id$="tbxPassExpDt"]' },
  { match: /city.*issuance|issuance.*city/i, sel: 'input[id$="tbxPassIssCit"]' },
  // Family Information — Father (confirmed from family--expanded.html)
  { match: /father.*surname|surname.*father/i,        sel: 'input[id$="tbxFATHER_SURNAME"]' },
  { match: /father.*given.?name|given.?name.*father/i, sel: 'input[id$="tbxFATHER_GIVEN_NAME"]' },
  { match: /father.*status|status.*father/i,           sel: 'select[id$="ddlFATHER_US_STATUS"]' },
  // Family Information — Mother (confirmed from family--expanded.html)
  { match: /mother.*surname|surname.*mother/i,         sel: 'input[id$="tbxMOTHER_SURNAME"]' },
  { match: /mother.*given.?name|given.?name.*mother/i, sel: 'input[id$="tbxMOTHER_GIVEN_NAME"]' },
  { match: /mother.*status|status.*mother/i,           sel: 'select[id$="ddlMOTHER_US_STATUS"]' },
  // Family Information — U.S. Relatives (confirmed from family--expanded.html)
  { match: /relative.*surname|surname.*relative/i,     sel: 'input[id$="tbxUS_REL_SURNAME"]' },
  { match: /relative.*given.?name|given.?name.*relative/i, sel: 'input[id$="tbxUS_REL_GIVEN_NAME"]' },
  { match: /relationship.*to you/i,                    sel: 'select[id$="ddlUS_REL_TYPE"]' },
  { match: /relative.*status/i,                        sel: 'select[id$="ddlUS_REL_STATUS"]' },
]

/**
 * Known "Does Not Apply" checkboxes mapped to the field they disable.
 * When GPT outputs {"type":"check","label":"Does Not Apply"} we try these
 * selectors first (most reliable) before falling back to generic scanning.
 *
 * Strategy: find the checkbox by its own ID, OR find it in the same <tr> as
 * the associated text input (DS-160 always puts them in the same table row).
 */
const DS160_KNOWN_CHECKBOXES = [
  {
    match: /^previous employer state\/province$/i,
    directSelectors: ['input[id*="dtlPrevEmpl"][id*="cbxPREV_EMPL_ADDR_STATE_NA"]'],
    nearInputSel: 'input[id*="dtlPrevEmpl"][id*="tbxPREV_EMPL_ADDR_STATE"]',
  },
  {
    match: /^previous employer postal zone\/zip code$/i,
    directSelectors: ['input[id*="dtlPrevEmpl"][id*="cbxPREV_EMPL_ADDR_POSTAL_CD_NA"]'],
    nearInputSel: 'input[id*="dtlPrevEmpl"][id*="tbxPREV_EMPL_ADDR_POSTAL_CD"]',
  },
  {
    match: /^previous employer supervisor surname$/i,
    directSelectors: ['input[id*="dtlPrevEmpl"][id*="cbxSupervisorSurname_NA"]'],
    nearInputSel: 'input[id*="dtlPrevEmpl"][id*="tbSupervisorSurname"]',
  },
  {
    match: /^previous employer supervisor given names?$/i,
    directSelectors: ['input[id*="dtlPrevEmpl"][id*="cbxSupervisorGivenName_NA"]'],
    nearInputSel: 'input[id*="dtlPrevEmpl"][id*="tbSupervisorGivenName"]',
  },
  {
    match: /^education state\/province$/i,
    directSelectors: ['input[id*="dtlPrevEduc"][id*="cbxEDUC_INST_ADDR_STATE_NA"]'],
    nearInputSel: 'input[id*="dtlPrevEduc"][id*="tbxEDUC_INST_ADDR_STATE"]',
  },
  {
    match: /^education postal zone\/zip code$/i,
    directSelectors: ['input[id*="dtlPrevEduc"][id*="cbxEDUC_INST_POSTAL_CD_NA"]'],
    nearInputSel: 'input[id*="dtlPrevEduc"][id*="tbxEDUC_INST_POSTAL_CD"]',
  },
  {
    match: /^secondary phone(?: number)?$/i,
    directSelectors: ['input[id$="cbexAPP_MOBILE_TEL_NA"]'],
    nearInputSel: 'input[id$="tbxAPP_MOBILE_TEL"]',
  },
  {
    match: /^work phone(?: number)?$/i,
    directSelectors: ['input[id$="cbexAPP_BUS_TEL_NA"]'],
    nearInputSel: 'input[id$="tbxAPP_BUS_TEL"]',
  },
  {
    match: /^mailing state\/province$/i,
    directSelectors: ['input[id$="cbexMAILING_ADDR_STATE_NA"]'],
    nearInputSel: 'input[id$="tbxMAILING_ADDR_STATE"]',
  },
  {
    match: /^mailing postal zone\/zip code$/i,
    directSelectors: ['input[id$="cbexMAILING_ADDR_POSTAL_CD_NA"]'],
    nearInputSel: 'input[id$="tbxMAILING_ADDR_POSTAL_CD"]',
  },
  {
    // State/Province of birth "Does Not Apply"
    match: /state.*province|province.*state|^state\/?province/i,
    directSelectors: [
      'input[id$="cbexAPP_ADDR_STATE_NA"]',
      'input[id$="cbexAPP_POB_ST_PROVINCE_NA"]',
      'input[type="checkbox"][id*="cbexAPP_POB_ST_PROVINCE"]',
      'input[type="checkbox"][id*="POB_ST_PROVINCE"]',
      'input[type="checkbox"][id*="POBSP"]',
      'input[id$="cbexMAILING_ADDR_STATE_NA"]',
    ],
    nearInputSel: 'input[id$="tbxAPP_POB_ST_PROVINCE"], input[id$="tbxPOBSP"]',
  },
  {
    // U.S. Social Security Number "Does Not Apply"
    match: /social security|ssn/i,
    directSelectors: [
      'input[id$="cbexAPP_SSN_NA"]',
      'input[type="checkbox"][id*="SSN_NA"]',
      'input[type="checkbox"][id*="SSN"]',
    ],
    nearInputSel: 'input[id$="tbxAPP_SSN1"], input[id*="SSN1"]',
  },
  {
    // U.S. Taxpayer ID Number "Does Not Apply"
    match: /taxpayer|tax.*id|tin/i,
    directSelectors: [
      'input[id$="cbexAPP_TAX_ID_NA"]',
      'input[type="checkbox"][id*="TAX_ID_NA"]',
      'input[type="checkbox"][id*="TAX_ID"]',
    ],
    nearInputSel: 'input[id$="tbxAPP_TAX_ID"], input[id*="TAX_ID"]',
  },
  {
    // Address postal/zip code "Does Not Apply"
    match: /postal|zip.*code|zip\s*\/?code/i,
    directSelectors: [
      'input[id$="cbexAPP_ADDR_POSTAL_CD_NA"]',
      'input[id$="cbexMAILING_ADDR_POSTAL_CD_NA"]',
      'input[type="checkbox"][id*="ADDR_POSTAL_CD_NA"]',
      'input[type="checkbox"][id*="POSTAL_CD_NA"]',
    ],
    nearInputSel: 'input[id$="tbxAPP_ADDR_POSTAL_CD"], input[id*="ADDR_POSTAL_CD"]',
  },
  {
    match: /visa number/i,
    directSelectors: ['input[id$="cbxPREV_VISA_FOIL_NUMBER_NA"]'],
    nearInputSel: 'input[id$="tbxPREV_VISA_FOIL_NUMBER"]',
  },
  {
    match: /driver.?s license number/i,
    directSelectors: ['input[id*="dtlUS_DRIVER_LICENSE"][id*="cbxUS_DRIVER_LICENSE_NA"]'],
    nearInputSel: 'input[id*="dtlUS_DRIVER_LICENSE"][id*="tbxUS_DRIVER_LICENSE"]',
  },
  {
    match: /passport book/i,
    directSelectors: [
      'input[id$="cbexPPT_BOOK_NUM_NA"]',
      'input[type="checkbox"][id*="PPT_BOOK_NUM_NA"]',
    ],
    nearInputSel: 'input[id$="tbxPPT_BOOK_NUM"]',
  },
  {
    // Family — Father's Date of Birth "Do Not Know" (confirmed from family--expanded.html)
    match: /father.*date|father.*dob|father.*birth/i,
    directSelectors: [
      'input[id$="cbxFATHER_DOB_UNK_IND"]',
      'input[type="checkbox"][id*="FATHER_DOB_UNK"]',
    ],
    nearInputSel: 'select[id$="ddlFathersDOBDay"]',
  },
  {
    // Family — Mother's Date of Birth "Do Not Know" (confirmed from family--expanded.html)
    match: /mother.*date|mother.*dob|mother.*birth/i,
    directSelectors: [
      'input[id$="cbxMOTHER_DOB_UNK_IND"]',
      'input[type="checkbox"][id*="MOTHER_DOB_UNK"]',
    ],
    nearInputSel: 'select[id$="ddlMothersDOBDay"]',
  },
  {
    // Travel — Payer email "Does Not Apply" (cbxDNAPAYER_EMAIL_ADDR_NA)
    // The email input is disabled by default; unchecking this enables it.
    match: /email.*paying|payer.*email|email.*person.*paying/i,
    directSelectors: [
      'input[id$="cbxDNAPAYER_EMAIL_ADDR_NA"]',
      'input[type="checkbox"][id*="PAYER_EMAIL"]',
    ],
    nearInputSel: 'input[id$="tbxPAYER_EMAIL_ADDR"], input[id*="PAYER_EMAIL_ADDR"]',
  },
  {
    // U.S. Point of Contact email "Does Not Apply".
    match: /point.*contact.*email|u\.?s\.?.*contact.*email|^email address$/i,
    directSelectors: [
      'input[id$="cbexUS_POC_EMAIL_ADDR_NA"]',
      'input[type="checkbox"][id*="US_POC_EMAIL_ADDR_NA"]',
    ],
    nearInputSel: 'input[id$="tbxUS_POC_EMAIL_ADDR"]',
  },
  {
    // U.S. Point of Contact organization "Do Not Know".
    match: /point.*contact.*organization|u\.?s\.?.*contact.*organization|organization name/i,
    directSelectors: [
      'input[id$="cbxUS_POC_ORG_NA_IND"]',
      'input[type="checkbox"][id*="US_POC_ORG_NA_IND"]',
    ],
    nearInputSel: 'input[id$="tbxUS_POC_ORGANIZATION"]',
  },
  {
    // U.S. Point of Contact surname / given name — one shared "Do Not Know" checkbox.
    match: /point.*contact.*(?:surname|given|name)|u\.?s\.?.*contact.*(?:surname|given|name)|contact person|^surnames?$|^(?:contact\s+)?(?:surnames?|given names?|first name|last name)$/i,
    directSelectors: [
      'input[id$="cbxUS_POC_NAME_NA"]',
      'input[type="checkbox"][id*="US_POC_NAME_NA"]',
    ],
    nearInputSel: 'input[id$="tbxUS_POC_SURNAME"], input[id$="tbxUS_POC_GIVEN_NAME"]',
  },
  {
    // Spouse City of Birth "Do Not Know"
    match: /spouse.*city|city.*birth.*spouse/i,
    directSelectors: [
      'input[id$="cbexSPOUSE_POB_CITY_NA"]',
      'input[type="checkbox"][id*="SPOUSE_POB_CITY_NA"]',
    ],
    nearInputSel: 'input[id$="tbxSpousePOBCity"]',
  },
]

async function educationRowHasStarted(page, occurrence = 1) {
  const names = page.locator('input[id*="dtlPrevEduc"][id*="tbxSchoolName"]')
  if (await names.count() < occurrence) return false
  return Boolean((await names.nth(occurrence - 1).inputValue().catch(() => '')).trim())
}

async function resolveWorkEducationCheckboxField(page, fieldLabel, occurrence = 1) {
  const normalizedLabel = String(fieldLabel || '').trim()

  // The model may use the visible DS-160 labels instead of our canonical
  // previous-employer labels. Route both supervisor checkboxes explicitly so a
  // generic "Do Not Know" lookup cannot accidentally select the surname row.
  if (/supervisor(?:'s)?\s+given names?/i.test(normalizedLabel)) {
    return 'Previous Employer Supervisor Given Names'
  }
  if (/supervisor(?:'s)?\s+surname/i.test(normalizedLabel)) {
    return 'Previous Employer Supervisor Surname'
  }

  if (!/^state\/province$|^postal zone\/zip code$|^zip code$/i.test(normalizedLabel)) {
    return fieldLabel
  }
  if (!await page.locator('input[id$="rblOtherEduc_0"]').count()) return fieldLabel

  const educationStarted = await educationRowHasStarted(page, occurrence)
  if (educationStarted) {
    return /state|province/i.test(fieldLabel)
      ? 'Education State/Province'
      : 'Education Postal Zone/ZIP Code'
  }

  return /state|province/i.test(fieldLabel)
    ? 'Previous Employer State/Province'
    : 'Previous Employer Postal Zone/ZIP Code'
}

function sameCi(left, right) {
  return String(left || '').trim().toUpperCase() === String(right || '').trim().toUpperCase()
}

const workPreviousCitySource = { employer: [], school: [] }

async function commitControl(locator) {
  await locator.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    if (typeof window.setDirty === 'function') {
      try { window.setDirty() } catch { /* ignore */ }
    }
  }).catch(() => {})
}

async function fillLocatedInput(locator, value) {
  await locator.scrollIntoViewIfNeeded().catch(() => {})
  await locator.waitFor({ state: 'visible', timeout: 5000 })
  await locator.fill(String(value || ''))
  await commitControl(locator)
}

/**
 * Previous employer and education share the visible label "City" on one CEAC
 * page. A bare "City" fill must not land in tbxEmpCity (that is how Hod HaSharon
 * was overwritten with Modiin). Matcher/LLM "Employer City" / tbxEmpCity still
 * writes the employer box.
 */
async function routeWorkPreviousCityFill(page, label, value, occurrence = 1, ref = '') {
  const normalizedLabel = String(label || '').trim()
  const core = controlName(ref)
  const empInputs = page.locator('input[id*="tbxEmpCity"], input[id$="tbxEmpCity"]')
  const schoolInputs = page.locator('input[id*="dtlPrevEduc"][id*="tbxSchoolCity"]')
  const hasEmp = await empInputs.count() > 0
  const hasSchool = await schoolInputs.count() > 0
  const idx = Math.max(0, occurrence - 1)

  const fillEmp = async () => {
    if (!hasEmp || await empInputs.count() <= idx) {
      throw missingUiTarget(`Previous employer city row ${occurrence} was not found`)
    }
    await fillLocatedInput(empInputs.nth(idx), value)
    log(`Filled previous employer city row ${occurrence}`)
    return true
  }
  const fillSchool = async () => {
    if (!hasSchool || await schoolInputs.count() <= idx) {
      throw missingUiTarget(`Education city row ${occurrence} was not found`)
    }
    await fillLocatedInput(schoolInputs.nth(idx), value)
    log(`Filled education city row ${occurrence}`)
    return true
  }

  if (/EmpCity$/i.test(core) || /^employer city$|^previous employer city$/i.test(normalizedLabel)) {
    return hasEmp ? fillEmp() : false
  }
  if (/SchoolCity$/i.test(core) || /^education city$/i.test(normalizedLabel)) {
    return hasSchool ? fillSchool() : false
  }
  if (!/^city$/i.test(normalizedLabel)) return false

  const empExpected = workPreviousCitySource.employer[idx] || workPreviousCitySource.employer[0]
  const schoolExpected = workPreviousCitySource.school[idx] || workPreviousCitySource.school[0]
  if (hasEmp && empExpected && sameCi(value, empExpected)) return fillEmp()
  if (hasSchool && schoolExpected && sameCi(value, schoolExpected)) return fillSchool()
  if (hasEmp && hasSchool) return fillSchool()
  if (hasSchool && await educationRowHasStarted(page, occurrence)) return fillSchool()
  return false
}

/**
 * Try to check a "Does Not Apply" checkbox for a specific known field.
 * Searches by direct ID, then by proximity to the associated input
 * (same <tr>, same parent <table>, or nearest "Does Not Apply" label in DOM order).
 */
async function checkDoesNotApplyFor(page, fieldLabel, occurrence = 1) {
  fieldLabel = await resolveWorkEducationCheckboxField(page, fieldLabel, occurrence)
  for (const { match, directSelectors, nearInputSel } of DS160_KNOWN_CHECKBOXES) {
    if (!match.test(fieldLabel)) continue

    // 1. Try direct ID selectors — use .click() (not .check()) so that the
    //    checkbox's onclick handler (e.g. enableTbx) fires correctly.
    for (const sel of directSelectors) {
      try {
        const matches = page.locator(sel)
        if (await matches.count() < occurrence) continue
        const el = matches.nth(occurrence - 1)
        await el.waitFor({ state: 'attached', timeout: 1500 })
        await el.scrollIntoViewIfNeeded().catch(() => {})
        if (!await el.isChecked()) await el.click()
        log(`✅ "Does Not Apply" clicked via direct selector: "${sel}"`)
        return true
      } catch { /* try next */ }
    }

    // 2. JS: find the checkbox whose label text is "Does Not Apply" that appears
    //    immediately after (or nearest to) the known input in the DOM.
    const inputSelFirst = nearInputSel.split(',')[0].trim()
    try {
      const clicked = await page.evaluate((inputSel) => {
        const inp = document.querySelector(inputSel)
        if (!inp) return false

        // Walk up to find the nearest ancestor that also contains a
        // "Does Not Apply" label/checkbox — try up to 6 levels.
        for (let el = inp.parentElement, depth = 0; el && depth < 6; el = el.parentElement, depth++) {
          const labels = Array.from(el.querySelectorAll('label'))
          const dnaLabel = labels.find(l => /does not apply/i.test(l.textContent || ''))
          if (dnaLabel) {
            // Click the associated checkbox (either via for= or adjacent input)
            const cbId = dnaLabel.getAttribute('for')
            const cb = cbId
              ? document.getElementById(cbId)
              : dnaLabel.previousElementSibling instanceof HTMLInputElement
                ? dnaLabel.previousElementSibling
                : el.querySelector('input[type="checkbox"]')
            if (cb) { cb.click(); return true }
          }
          // Also check for a checkbox directly (no label) in the container
          const cbs = Array.from(el.querySelectorAll('input[type="checkbox"]'))
          if (cbs.length === 1) { cbs[0].click(); return true }
        }
        return false
      }, inputSelFirst)

      if (clicked) {
        log('✅ "Does Not Apply" clicked via JS proximity search')
        return true
      }
    } catch { /* ignore */ }

    // 3. Playwright: find a label with text "Does Not Apply" in the same
    //    ancestor <table> as the input (handles separate <tr> layout).
    for (const inputSel of nearInputSel.split(',').map(s => s.trim())) {
      try {
        const inp = page.locator(inputSel).first()
        await inp.waitFor({ state: 'attached', timeout: 2000 })
        const table = inp.locator('xpath=ancestor::table[1]')
        const dnaLabel = table.locator('label:has-text("Does Not Apply")').first()
        if (await dnaLabel.count() > 0) {
          await dnaLabel.scrollIntoViewIfNeeded().catch(() => {})
          await dnaLabel.click()
          log(`✅ "Does Not Apply" clicked via ancestor-table label search`)
          return true
        }
        // If no label, grab the only checkbox in the table and click it
        const cb = table.locator('input[type="checkbox"]').first()
        if (await cb.count() > 0) {
          await cb.scrollIntoViewIfNeeded().catch(() => {})
          if (!await cb.isChecked()) await cb.click()
          log(`✅ "Does Not Apply" clicked via ancestor-table checkbox`)
          return true
        }
      } catch { /* try next */ }
    }
  }
  return false
}

async function routeWorkEducationMarkerToCheckbox(page, label, value, occurrence = 1) {
  const normalizedValue = String(value || '').trim().toUpperCase()
  if (!['N/A', 'DOES NOT APPLY', 'DO NOT KNOW'].includes(normalizedValue)) return false

  const onPreviousWorkPage =
    await page.locator('input[id$="rblPreviouslyEmployed_0"], input[id$="rblOtherEduc_0"]').count() > 0
  if (!onPreviousWorkPage) return false

  const normalizedLabel = String(label || '').trim()
  const explicitField =
    /previous employer state/i.test(normalizedLabel) ? 'Previous Employer State/Province'
      : /previous employer.*(?:postal|zip)/i.test(normalizedLabel) ? 'Previous Employer Postal Zone/ZIP Code'
        : /education state/i.test(normalizedLabel) ? 'Education State/Province'
          : /education.*(?:postal|zip)/i.test(normalizedLabel) ? 'Education Postal Zone/ZIP Code'
            : /supervisor.*surname/i.test(normalizedLabel) ? 'Previous Employer Supervisor Surname'
              : /supervisor.*given/i.test(normalizedLabel) ? 'Previous Employer Supervisor Given Names'
                : ''

  if (explicitField) {
    const handled = await checkDoesNotApplyFor(page, explicitField, occurrence)
    if (!handled) {
      throw missingUiTarget(`Checkbox not found for marker value in "${normalizedLabel}"`)
    }
    log(`Converted "${normalizedValue}" to checkbox action for "${explicitField}"`)
    return true
  }

  const isState = /state|province/i.test(normalizedLabel)
  const isPostal = /postal|zip/i.test(normalizedLabel)
  if (!isState && !isPostal) return false

  const candidates = isState
    ? [
        {
          fieldLabel: 'Previous Employer State/Province',
          input: 'input[id*="dtlPrevEmpl"][id*="tbxPREV_EMPL_ADDR_STATE"]',
        },
        {
          fieldLabel: 'Education State/Province',
          input: 'input[id*="dtlPrevEduc"][id*="tbxEDUC_INST_ADDR_STATE"]',
        },
      ]
    : [
        {
          fieldLabel: 'Previous Employer Postal Zone/ZIP Code',
          input: 'input[id*="dtlPrevEmpl"][id*="tbxPREV_EMPL_ADDR_POSTAL_CD"]',
        },
        {
          fieldLabel: 'Education Postal Zone/ZIP Code',
          input: 'input[id*="dtlPrevEduc"][id*="tbxEDUC_INST_POSTAL_CD"]',
        },
      ]

  for (const candidate of candidates) {
    const inputs = page.locator(candidate.input)
    if (await inputs.count() < occurrence) continue
    const input = inputs.nth(occurrence - 1)
    const eligible = await input.evaluate((element) => {
      const current = String(element.value || '').trim().toUpperCase()
      const marker = ['N/A', 'DOES NOT APPLY', 'DO NOT KNOW'].includes(current)
      return !element.disabled && (!current || marker)
    }).catch(() => false)
    if (!eligible) continue

    const handled = await checkDoesNotApplyFor(page, candidate.fieldLabel, occurrence)
    if (handled) {
      log(`Converted "${normalizedValue}" to checkbox action for "${candidate.fieldLabel}"`)
      return true
    }
  }

  throw missingUiTarget(`No applicable checkbox found for marker value in "${normalizedLabel}"`)
}

const PAYER_COMPANY_FIELDS = [
  { match: /^name of company\/organization paying(?: for trip)?$/i, name: 'Name of Company/Organization Paying for Trip', kind: 'input' },
  { match: /^telephone number of company paying$/i, name: 'Telephone Number', kind: 'input', digits: true },
  { match: /^relationship of company paying$/i, name: 'Relationship to You', kind: 'input' },
  { match: /^payer company street address \(line 1\)$/i, name: 'Street Address (Line 1)', kind: 'input' },
  { match: /^payer company street address \(line 2\)$/i, name: 'Street Address (Line 2)', kind: 'input' },
  { match: /^payer company city$/i, name: 'City', kind: 'input' },
  { match: /^payer company state\/province$/i, name: 'State/Province', kind: 'input', dna: true },
  { match: /^payer company postal(?: zone\/zip code)?$/i, name: 'Postal Zone/ZIP Code', kind: 'input', dna: true },
  { match: /^payer company country\/region$/i, name: 'Country/Region', kind: 'select' },
]

export function matchPayerCompanyField(label) {
  const text = String(label || '').trim()
  return PAYER_COMPANY_FIELDS.find((spec) => spec.match.test(text)) || null
}

async function payerCompanyControl(page, spec) {
  const panel = page.locator('[id$="upnlPayer"]').first()
  await panel.waitFor({ state: 'attached', timeout: 8000 })
  const role = spec.kind === 'select' ? 'combobox' : 'textbox'
  const el = panel.getByRole(role, { name: spec.name }).first()
  await el.waitFor({ state: 'attached', timeout: 5000 })
  return el
}

async function payerCompanyDoesNotApplyBox(input) {
  const field = input.locator('xpath=ancestor::div[contains(@class,"field")][1]')
  const inField = field.locator('input[type="checkbox"]').first()
  if (await inField.count() > 0) return inField
  return input.locator('xpath=following::input[@type="checkbox"][1]')
}

async function setPayerCompanyDoesNotApply(page, spec) {
  const input = await payerCompanyControl(page, spec)
  const box = await payerCompanyDoesNotApplyBox(input)
  await box.waitFor({ state: 'attached', timeout: 3000 })
  if (!await box.isChecked()) await box.click()
  log(`Checked payer company "${spec.name}" Does Not Apply`)
}

async function fillPayerCompanyControl(page, spec, value) {
  const raw = String(value ?? '')
  const marker = /^(?:n\/?a|does not apply)$/i.test(raw.trim())
  if (spec.dna && (marker || !raw.trim())) {
    await setPayerCompanyDoesNotApply(page, spec)
    return
  }
  const el = await payerCompanyControl(page, spec)
  if (spec.dna) {
    const box = await payerCompanyDoesNotApplyBox(el)
    if (await box.count() > 0 && await box.isChecked().catch(() => false)) {
      await box.click()
      await page.waitForTimeout(200)
    }
  }
  if (spec.kind === 'select') {
    const requested = raw.trim()
    const picked = await el.evaluate((select, wanted) => {
      const normalized = String(wanted).trim().toLowerCase()
      const option = Array.from(select.options).find((candidate) => {
        const text = candidate.text.trim().toLowerCase()
        return text === normalized ||
          candidate.value.trim().toLowerCase() === normalized ||
          text.startsWith(normalized)
      })
      if (!option) return false
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, requested)
    if (!picked) throw new Error(`Could not select "${requested}" for payer company ${spec.name}`)
    log(`Selected payer company ${spec.name}: "${requested}"`)
    return
  }
  let text = spec.digits ? raw.replace(/\D/g, '') : raw
  if (!spec.digits) {
    const max = Number(await el.getAttribute('maxlength'))
    if (Number.isFinite(max) && max > 0) text = fitDs160Value(text, max)
  }
  await el.scrollIntoViewIfNeeded().catch(() => {})
  await el.fill(text)
  log(`Filled payer company ${spec.name}`)
}

async function routePayerCompanyField(page, action) {
  const type = String(action.type || '')
  const label = String(action.label || '').trim()
  const fieldLabel = String(action.fieldLabel || action.for || '').trim()
  let spec = matchPayerCompanyField(label) ||
    (type === 'check' ? matchPayerCompanyField(fieldLabel) : null)
  // Company payers use a free-text "Relationship to You". Other Person uses a
  // dropdown with the same words, so only steal that label when the company
  // name box is actually on the page.
  if (!spec && /^relationship to you$/i.test(label) && await companyPayerNameBox(page)) {
    spec = PAYER_COMPANY_FIELDS.find((item) => item.name === 'Relationship to You') || null
  }
  if (!spec) return false
  if (type === 'check') {
    if (!spec.dna) return false
    await setPayerCompanyDoesNotApply(page, spec)
    return true
  }
  if (type === 'fill' || type === 'selectOption') {
    const value = payerCompanyValueForSpec(spec, action.value)
    await fillPayerCompanyControl(page, spec, value)
    return true
  }
  return false
}

let expectedPayerCompany = null

function payerCompanyBlock(sectionText) {
  return String(sectionText || '').match(
    /\*{0,2}PERSON\/ENTITY PAYING\b[\s\S]*?(?=\n🟦|$)/i,
  )?.[0] || ''
}

export function parsePayerCompanyFromSource(sectionText) {
  const block = payerCompanyBlock(sectionText)
  if (!block) return null
  const who = block.match(/who is paying for the trip\??\s*:?\s*(.+)$/im)?.[1]?.trim() || ''
  if (!/company|organization/i.test(who)) return null
  const parsed = {
    name: sourceLineValue(block, 'Name of Company/Organization Paying for Trip'),
    phone: sourceLineValue(block, 'Telephone Number').replace(/\D/g, ''),
    relationship: sourceLineValue(block, 'Relationship to You'),
    street1: sourceLineValue(block, 'Street Address (Line 1)'),
    street2: sourceLineValue(block, 'Street Address (Line 2)'),
    city: sourceLineValue(block, 'City'),
    state: sourceLineValue(block, 'State/Province'),
    zip: sourceLineValue(block, 'Postal Zone/ZIP Code'),
    country: sourceLineValue(block, 'Country/Region'),
  }
  if (!parsed.name && !parsed.street1) return null
  return parsed
}

function payerCompanyValueForSpec(spec, fallback) {
  const expected = expectedPayerCompany
  const incoming = String(fallback || '').trim()
  if (!expected) return fallback
  if (spec.name !== 'Name of Company/Organization Paying for Trip') return fallback
  const relationship = String(expected.relationship || '').trim()
  const looksLikeRole = relationship &&
    incoming.toUpperCase().startsWith(relationship.slice(0, 20).toUpperCase())
  if (!incoming || looksLikeRole) return expected.name || fallback
  return fallback
}

async function companyPayerNameBox(page) {
  const panel = page.locator('[id$="upnlPayer"]').first()
  if (await panel.count() === 0) return null
  const box = panel.getByRole('textbox', { name: 'Name of Company/Organization Paying for Trip' }).first()
  if (await box.count() === 0) return null
  return box
}

async function selectCompanyPayer(page) {
  const select = page.locator('select[id$="ddlWhoIsPaying"]').first()
  if (await select.count() === 0) return false
  const current = await select.evaluate((el) => el.options[el.selectedIndex]?.text || '').catch(() => '')
  if (/other company/i.test(current)) return false
  const picked = await select.evaluate((el) => {
    const option = Array.from(el.options).find((candidate) =>
      /other company/i.test(candidate.text) || candidate.value === 'C',
    )
    if (!option) return false
    el.value = option.value
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }).catch(() => false)
  if (!picked) return false
  log('Selected Other Company/Organization as the trip payer')
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  return true
}

async function payerCompanyText(page, spec) {
  const el = await payerCompanyControl(page, spec)
  if (spec.kind === 'select') {
    return el.evaluate((select) => select.options[select.selectedIndex]?.text || '').catch(() => '')
  }
  return el.inputValue().catch(() => '')
}

function samePayerText(current, next) {
  return String(current || '').trim().toUpperCase() === String(next || '').trim().toUpperCase()
}

export async function syncPayerCompanyFromSource(page, sectionText) {
  const parsed = parsePayerCompanyFromSource(sectionText)
  expectedPayerCompany = parsed
  if (!parsed) return false

  const nameBox = await companyPayerNameBox(page)
  if (!nameBox) return selectCompanyPayer(page)

  const fields = [
    ['Name of Company/Organization Paying for Trip', parsed.name],
    ['Telephone Number', parsed.phone],
    ['Relationship to You', parsed.relationship],
    ['Street Address (Line 1)', parsed.street1],
    ['Street Address (Line 2)', parsed.street2],
    ['City', parsed.city],
    ['State/Province', parsed.state],
    ['Postal Zone/ZIP Code', parsed.zip],
    ['Country/Region', parsed.country],
  ]
  let changed = false
  for (const [label, value] of fields) {
    if (!String(value || '').trim()) continue
    const spec = PAYER_COMPANY_FIELDS.find((item) => item.name === label)
    if (!spec) continue
    if (spec.dna && isMarkerValue(value)) {
      const input = await payerCompanyControl(page, spec)
      const box = await payerCompanyDoesNotApplyBox(input)
      if (await box.count() === 0 || await box.isChecked().catch(() => false)) continue
      await setPayerCompanyDoesNotApply(page, spec)
      changed = true
      continue
    }
    if (spec.kind !== 'select' && !spec.digits) {
      const el = await payerCompanyControl(page, spec)
      const max = Number(await el.getAttribute('maxlength'))
      const fitted = Number.isFinite(max) && max > 0 ? fitDs160Value(value, max) : value
      if (samePayerText(await el.inputValue().catch(() => ''), fitted)) continue
      await fillPayerCompanyControl(page, spec, fitted)
      changed = true
      continue
    }
    const current = await payerCompanyText(page, spec)
    const next = spec.digits ? String(value).replace(/\D/g, '') : value
    if (spec.kind === 'select') {
      if (current.trim().toLowerCase().startsWith(String(next).trim().toLowerCase())) continue
    } else if (samePayerText(current, next)) {
      continue
    }
    await fillPayerCompanyControl(page, spec, next)
    changed = true
  }
  if (changed) {
    log(`Synchronized company payer: ${parsed.name}, ${parsed.city}, ${parsed.country}`)
  }
  return changed
}

async function routePersonal1BirthStateDoesNotApply(page, action) {
  const type = String(action.type || '')
  const label = String(action.label || '')
  const fieldLabel = String(action.fieldLabel || action.for || '')
  const value = String(action.value || '').trim()
  const markerValue = /^(?:n\/?a|does not apply)$/i.test(value)
  const stateField = /state.*province|province.*state/i.test(label) ||
    /state.*province|province.*state/i.test(fieldLabel)
  const genericCheck = type === 'check' &&
    /does not apply/i.test(label) &&
    !fieldLabel

  if (!((['fill', 'selectOption'].includes(type) && markerValue && stateField) || genericCheck)) {
    return false
  }

  const checkbox = page.locator('input[id$="cbexAPP_POB_ST_PROVINCE_NA"]').first()
  if (await checkbox.count() === 0) return false

  const stateInput = page.locator('input[id$="tbxAPP_POB_ST_PROVINCE"]').first()
  const stateValue = await stateInput.inputValue({ timeout: 500 }).catch(() => '')
  if (stateValue.trim()) return false

  await checkbox.scrollIntoViewIfNeeded().catch(() => {})
  if (!await checkbox.isChecked()) await checkbox.click()
  log('Checked Personal Information 1 birth State/Province "Does Not Apply"')
  return true
}

async function routeUSContactOrganizationMarker(page, action) {
  if (action.type !== 'fill') return false
  if (!/^(?:u\.?s\.?\s+(?:point of )?contact\s+)?organization name$/i.test(String(action.label || '').trim())) {
    return false
  }
  if (!/^(?:n\/?a|does not apply|do not know|unknown)$/i.test(String(action.value || '').trim())) {
    return false
  }

  const checkbox = page.locator('input[id$="cbxUS_POC_ORG_NA_IND"]').first()
  if (await checkbox.count() === 0) return false

  await checkbox.scrollIntoViewIfNeeded().catch(() => {})
  if (!await checkbox.isChecked()) await checkbox.click()
  log('Checked U.S. Point of Contact Organization Name "Do Not Know"')
  return true
}

function isUsContactPersonNameAction(action) {
  const ref = String(action.ref || '')
  const label = String(action.label || action.fieldLabel || '').trim()
  return (
    /tbxUS_POC_(SURNAME|GIVEN_NAME)/i.test(ref) ||
    /^(?:u\.?s\.?\s+(?:point of )?contact\s+)?(?:contact\s+person\s+)?(?:surnames?|given names?)$/i.test(label)
  )
}

async function checkUsContactPersonNameUnknown(page) {
  const checkbox = page.locator('input[id$="cbxUS_POC_NAME_NA"]').first()
  if (await checkbox.count() === 0) return false
  await checkbox.scrollIntoViewIfNeeded().catch(() => {})
  if (!await checkbox.isChecked()) await checkbox.click()
  log('Checked U.S. Point of Contact person name "Do Not Know"')
  return true
}

async function routeUSContactPersonNameMarker(page, action) {
  if (action.type !== 'fill') return false
  if (!isUsContactPersonNameAction(action)) return false
  if (!isMarkerValue(action.value)) return false
  return checkUsContactPersonNameUnknown(page)
}

/** CEAC requires a person name or an organization — never a filled org with blank names. */
async function ensureUsContactNameDoNotKnowIfOrgOnly(page) {
  const org = page.locator('input[id$="tbxUS_POC_ORGANIZATION"]').first()
  if (await org.count() === 0) return false
  const orgValue = String(await org.inputValue().catch(() => '')).trim()
  if (!orgValue || isMarkerValue(orgValue)) return false

  const surname = String(
    await page.locator('input[id$="tbxUS_POC_SURNAME"]').first().inputValue().catch(() => ''),
  ).trim()
  const given = String(
    await page.locator('input[id$="tbxUS_POC_GIVEN_NAME"]').first().inputValue().catch(() => ''),
  ).trim()
  const realSurname = surname && !isMarkerValue(surname)
  const realGiven = given && !isMarkerValue(given)
  if (realSurname || realGiven) return false

  const checked = await checkUsContactPersonNameUnknown(page)
  if (checked) {
    log('Organization is filled and contact person is blank — ticked person name "Do Not Know"')
  }
  return checked
}

async function clickAspNetPostBackLink(link) {
  await link.scrollIntoViewIfNeeded().catch(() => {})
  const href = await link.getAttribute('href').catch(() => '')
  const postback = String(href || '').match(/__doPostBack\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/)
  if (postback) {
    const page = link.page()
    try {
      const invoked = await page.evaluate(({ target, argument }) => {
        try { window.needToConfirm = false } catch { /* ignore */ }
        if (typeof window.__doPostBack !== 'function') return false
        window.__doPostBack(target, argument)
        return true
      }, { target: postback[1], argument: postback[2] })
      if (invoked) return
    } catch (err) {
      if (/execution context.*destroyed|navigation/i.test(err.message || '')) return
    }
  }
  try {
    // A real click runs ASP.NET outside Playwright's strict-mode evaluate
    // function. PageRequestManager reads caller.arguments and otherwise throws.
    await link.click()
  } catch (err) {
    if (/execution context.*destroyed|navigation/i.test(err.message || '')) return
    throw err
  }
}

async function addRepeaterRow(page, addLinks, rowLocator, nextIndex, logLabel) {
  const linkCount = await addLinks.count()
  if (!linkCount) {
    log(`[${logLabel}] Add Another link not found at row ${nextIndex + 1}`)
    return false
  }
  const link = addLinks.nth(linkCount - 1)
  await clickAspNetPostBackLink(link)
  const appeared = await rowLocator.nth(nextIndex)
    .waitFor({ state: 'attached', timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (appeared) {
    log(`[${logLabel}] Added row ${nextIndex + 1}`)
    return true
  }
  log(`[${logLabel}] Add Another did not create row ${nextIndex + 1}`)
  return false
}

/**
 * Known radio-button questions mapped to their ASP.NET RadioButtonList IDs.
 * Index _0 = Yes, _1 = No (standard ASP.NET rendering).
 * value="Y" / value="N" is the common DS-160 pattern.
 */
const securityRadio = (match, id) => ({
  match,
  yesSelectors: [`input[id$="${id}_0"]`],
  noSelectors: [`input[id$="${id}_1"]`],
})

export const DS160_KNOWN_RADIOS = [
  {
    // Personal 2 — "Are you a permanent resident of a country/region other than..."
    // Must come BEFORE the "other nationality" entry because "other...nationality" would
    // also match the permanent-resident question label.
    match: /permanent resident/i,
    yesSelectors: ['input[id$="rblPermResOtherCntryInd_0"]', 'input[id*="rblPermResOtherCntryInd"][value="Y"]'],
    noSelectors:  ['input[id$="rblPermResOtherCntryInd_1"]', 'input[id*="rblPermResOtherCntryInd"][value="N"]'],
  },
  {
    // Personal 2 — "Do you hold or have you held any nationality other than..."
    // Requires "hold"/"held" to avoid matching the permanent-resident question above.
    match: /hold.*national|held.*national|any nationality other/i,
    yesSelectors: ['input[id$="rblAPP_OTH_NATL_IND_0"]', 'input[id*="rblAPP_OTH_NATL_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblAPP_OTH_NATL_IND_1"]', 'input[id*="rblAPP_OTH_NATL_IND"][value="N"]'],
  },
  {
    match: /other names|maiden|alias|professional.*name|religious.*name/i,
    yesSelectors: ['input[id$="rblOtherNames_0"]', 'input[id*="rblOtherNames"][value="Y"]'],
    noSelectors:  ['input[id$="rblOtherNames_1"]', 'input[id*="rblOtherNames"][value="N"]'],
  },
  {
    match: /telecode/i,
    yesSelectors: ['input[id$="rblTelecodeQuestion_0"]', 'input[id*="rblTelecodeQuestion"][value="Y"]'],
    noSelectors:  ['input[id$="rblTelecodeQuestion_1"]', 'input[id*="rblTelecodeQuestion"][value="N"]'],
  },
  {
    // Actual ASP.NET ID: rblSpecificTravel (NOT rblSpecificTravelPlans)
    match: /specific travel plans|made.*specific|travel plans/i,
    yesSelectors: [
      'input[id$="rblSpecificTravel_0"]',
      'input[id*="rblSpecificTravel"][value="Y"]',
      'input[id*="rblSpecificTravelPlans_0"]',
      'input[id*="SpecificTravelPlans"][value="Y"]',
    ],
    noSelectors: [
      'input[id$="rblSpecificTravel_1"]',
      'input[id*="rblSpecificTravel"][value="N"]',
      'input[id*="rblSpecificTravelPlans_1"]',
      'input[id*="SpecificTravelPlans"][value="N"]',
    ],
  },
  {
    // Travel Companions — keep these two similarly worded questions isolated.
    match: /are there other persons traveling with you/i,
    yesSelectors: [
      'input[id$="rblOtherPersonsTravelingWithYou_0"]',
      'input[id*="rblOtherPersonsTravelingWithYou"][value="Y"]',
    ],
    noSelectors: [
      'input[id$="rblOtherPersonsTravelingWithYou_1"]',
      'input[id*="rblOtherPersonsTravelingWithYou"][value="N"]',
    ],
  },
  {
    match: /traveling as part of a group or organization/i,
    yesSelectors: [
      'input[id$="rblGroupTravel_0"]',
      'input[id*="rblGroupTravel"][value="Y"]',
    ],
    noSelectors: [
      'input[id$="rblGroupTravel_1"]',
      'input[id*="rblGroupTravel"][value="N"]',
    ],
  },
  {
    match: /mailing address.*same.*home|same.*home address.*mailing/i,
    yesSelectors: ['input[id$="rblMailingAddrSame_0"]'],
    noSelectors: ['input[id$="rblMailingAddrSame_1"]'],
  },
  {
    match: /other phone numbers.*last five years/i,
    yesSelectors: ['input[id$="rblAddPhone_0"]'],
    noSelectors: ['input[id$="rblAddPhone_1"]'],
  },
  {
    match: /other email addresses.*last five years/i,
    yesSelectors: ['input[id$="rblAddEmail_0"]'],
    noSelectors: ['input[id$="rblAddEmail_1"]'],
  },
  {
    match: /other websites or applications.*last five years|wish to provide.*other websites/i,
    yesSelectors: ['input[id$="rblAddSocial_0"]'],
    noSelectors: ['input[id$="rblAddSocial_1"]'],
  },
  // Previous U.S. Travel page — labels match translated.txt exactly
  {
    // "Have you ever been in the United States?"
    match: /have you ever been in the united states|ever been in the u\.?s\.?/i,
    yesSelectors: ['input[id$="rblPREV_US_TRAVEL_IND_0"]', 'input[id*="rblPREV_US_TRAVEL_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblPREV_US_TRAVEL_IND_1"]', 'input[id*="rblPREV_US_TRAVEL_IND"][value="N"]'],
  },
  {
    // "Have you ever been issued a U.S. visa?"
    match: /have you ever been issued a u\.?s\.? visa|ever been issued.*visa/i,
    yesSelectors: ['input[id$="rblPREV_VISA_IND_0"]', 'input[id*="rblPREV_VISA_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblPREV_VISA_IND_1"]', 'input[id*="rblPREV_VISA_IND"][value="N"]'],
  },
  {
    match: /hold a u\.?s\.? driver.?s license/i,
    yesSelectors: ['input[id$="rblPREV_US_DRIVER_LIC_IND_0"]'],
    noSelectors:  ['input[id$="rblPREV_US_DRIVER_LIC_IND_1"]'],
  },
  {
    match: /same type of visa/i,
    yesSelectors: ['input[id$="rblPREV_VISA_SAME_TYPE_IND_0"]'],
    noSelectors:  ['input[id$="rblPREV_VISA_SAME_TYPE_IND_1"]'],
  },
  {
    match: /same country or location where the visa/i,
    yesSelectors: ['input[id$="rblPREV_VISA_SAME_CNTRY_IND_0"]'],
    noSelectors:  ['input[id$="rblPREV_VISA_SAME_CNTRY_IND_1"]'],
  },
  {
    match: /ten-printed/i,
    yesSelectors: ['input[id$="rblPREV_VISA_TEN_PRINT_IND_0"]'],
    noSelectors:  ['input[id$="rblPREV_VISA_TEN_PRINT_IND_1"]'],
  },
  {
    match: /visa ever been lost or stolen/i,
    yesSelectors: ['input[id$="rblPREV_VISA_LOST_IND_0"]'],
    noSelectors:  ['input[id$="rblPREV_VISA_LOST_IND_1"]'],
  },
  {
    match: /visa ever been cancelled or revoked/i,
    yesSelectors: ['input[id$="rblPREV_VISA_CANCELLED_IND_0"]'],
    noSelectors:  ['input[id$="rblPREV_VISA_CANCELLED_IND_1"]'],
  },
  {
    // "Have you ever been refused a U.S. visa or denied admission?"
    match: /refused a u\.?s\.? visa or denied admission|refused.*visa.*denied|visa refused|refused admission|withdrawn.*port/i,
    yesSelectors: ['input[id$="rblPREV_VISA_REFUSED_IND_0"]', 'input[id*="rblPREV_VISA_REFUSED_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblPREV_VISA_REFUSED_IND_1"]', 'input[id*="rblPREV_VISA_REFUSED_IND"][value="N"]'],
  },
  {
    // "Has anyone ever filed an immigrant petition on your behalf?"
    match: /filed an immigrant petition on your behalf|immigrant petition.*behalf|iv.*petition/i,
    yesSelectors: ['input[id$="rblIV_PETITION_IND_0"]', 'input[id*="rblIV_PETITION_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblIV_PETITION_IND_1"]', 'input[id*="rblIV_PETITION_IND"][value="N"]'],
  },
  {
    match: /ever lost a passport|passport.*lost or stolen/i,
    yesSelectors: ['input[id$="rblLOST_PPT_IND_0"]', 'input[id*="rblLOST_PPT_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblLOST_PPT_IND_1"]', 'input[id*="rblLOST_PPT_IND"][value="N"]'],
  },
  // Additional Work/Education/Training
  securityRadio(/belong to a clan or tribe/i, 'rblCLAN_TRIBE_IND'),
  securityRadio(/traveled to any countries.*last five years|countries.*visited.*last five years/i, 'rblCOUNTRIES_VISITED_IND'),
  securityRadio(/professional, social, or charitable organization|belonged to.*organization/i, 'rblORGANIZATION_IND'),
  securityRadio(/specialized skills or training|firearms.*explosives/i, 'rblSPECIALIZED_SKILLS_IND'),
  securityRadio(/(?:ever )?served in the military/i, 'rblMILITARY_SERVICE_IND'),
  securityRadio(/paramilitary unit|vigilante unit|rebel group|guerrilla group|insurgent organization/i, 'rblINSURGENT_ORG_IND'),
  // Security and Background 1 — Medical and Health
  securityRadio(/communicable disease/i, 'rblDisease'),
  securityRadio(/mental disorders? posing danger|mental or physical disorder|disorder.*(?:threat|danger)/i, 'rblDisorder'),
  securityRadio(/drug abuse or addiction|drug abuser or addict/i, 'rblDruguser'),

  // Security and Background 2 — Criminal
  securityRadio(/arrests? or convictions?|arrested or convicted/i, 'rblArrested'),
  securityRadio(/drug law violations?|controlled substances/i, 'rblControlledSubstances'),
  securityRadio(/prostitution|commercialized vice/i, 'rblProstitution'),
  securityRadio(/money laundering/i, 'rblMoneyLaundering'),
  // Put the two specific trafficking questions before the general one.
  securityRadio(/aided|abetted|assisted.*trafficking|colluded.*trafficking/i, 'rblAssistedSevereTrafficking'),
  securityRadio(/spouse,? son,? or daughter.*trafficking|benefited from.*trafficking/i, 'rblHumanTraffickingRelated'),
  securityRadio(/human trafficking/i, 'rblHumanTrafficking'),

  // Security and Background 3 — Security / Human Rights
  securityRadio(/espionage|sabotage|export violations?|illegal activity/i, 'rblIllegalActivity'),
  // Keep the specific relative question before the generic terrorist-activity
  // rule: source documents use "Being the spouse or child ... terrorist
  // activities", which otherwise matches rblTerroristActivity first.
  securityRadio(/spouse,? son,? or daughter.*terrorist|(?:being|are you) the spouse or child.*terrorist|relative.*terrorist/i, 'rblTerroristRel'),
  securityRadio(/terrorist activities/i, 'rblTerroristActivity'),
  securityRadio(/support to terrorist|support.*terrorist organizations?|financial assistance.*terrorist/i, 'rblTerroristSupport'),
  securityRadio(/membership in terrorist|member or representative.*terrorist/i, 'rblTerroristOrg'),
  securityRadio(/genocide/i, 'rblGenocide'),
  securityRadio(/torture/i, 'rblTorture'),
  securityRadio(/extrajudicial killings?|political killings?|other acts of violence/i, 'rblExViolence'),
  securityRadio(/child soldiers?/i, 'rblChildSoldier'),
  securityRadio(/religious freedom violations?/i, 'rblReligiousFreedom'),
  securityRadio(/population controls?|forced abortion|forced sterilization/i, 'rblPopulationControls'),
  securityRadio(/organ transplantation|transplantation of human organs/i, 'rblTransplant'),

  // Security and Background 4 — Immigration
  securityRadio(/subject of a removal or deportation hearing|removal hearing/i, 'rblRemovalHearing'),
  securityRadio(/visa fraud|immigration fraud|immigration benefit by fraud|willful misrepresentation/i, 'rblImmigrationFraud'),
  securityRadio(/failed to attend.*(?:removability|inadmissibility)|hearing on removability/i, 'rblFailToAttend'),
  securityRadio(/unlawfully present|overstayed|violated the terms of a u\.?s\.? visa|visa violation/i, 'rblVisaViolation'),
  securityRadio(/deportation or removal|removed or deported/i, 'rblDeport'),

  // Security and Background 5 — Miscellaneous
  securityRadio(/withheld custody|child custody/i, 'rblChildCustody'),
  securityRadio(/illegal voting|voted.*violation/i, 'rblVotingViolation'),
  securityRadio(/renouncing.*citizenship|renounced.*citizenship|avoiding taxation/i, 'rblRenounceExp'),

  // Family Information — confirmed from family--expanded.html
  {
    match: /father.*in.*u\.?s\.?|is your father|father.*live in|father.*united states/i,
    yesSelectors: ['input[id$="rblFATHER_LIVE_IN_US_IND_0"]', 'input[id*="rblFATHER_LIVE_IN_US_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblFATHER_LIVE_IN_US_IND_1"]', 'input[id*="rblFATHER_LIVE_IN_US_IND"][value="N"]'],
  },
  {
    match: /mother.*in.*u\.?s\.?|is your mother|mother.*live in|mother.*united states/i,
    yesSelectors: ['input[id$="rblMOTHER_LIVE_IN_US_IND_0"]', 'input[id*="rblMOTHER_LIVE_IN_US_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblMOTHER_LIVE_IN_US_IND_1"]', 'input[id*="rblMOTHER_LIVE_IN_US_IND"][value="N"]'],
  },
  {
    match: /immediate relatives.*not including parents|do you have.*immediate relative|relatives.*in.*u\.?s\.?.*not.*parent/i,
    yesSelectors: ['input[id$="rblUS_IMMED_RELATIVE_IND_0"]', 'input[id*="rblUS_IMMED_RELATIVE_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblUS_IMMED_RELATIVE_IND_1"]', 'input[id*="rblUS_IMMED_RELATIVE_IND"][value="N"]'],
  },
  {
    match: /do you have any other relatives in the united states|other relatives.*u\.?s\.?/i,
    yesSelectors: ['input[id$="rblUS_OTHER_RELATIVE_IND_0"]', 'input[id*="rblUS_OTHER_RELATIVE_IND"][value="Y"]'],
    noSelectors:  ['input[id$="rblUS_OTHER_RELATIVE_IND_1"]', 'input[id*="rblUS_OTHER_RELATIVE_IND"][value="N"]'],
  },
  {
    match: /attended any educational institutions|educational institutions.*secondary level/i,
    yesSelectors: ['input[id$="rblOtherEduc_0"]'],
    noSelectors:  ['input[id$="rblOtherEduc_1"]'],
  },
  {
    // Travel — "Is the address of the party paying for your trip the same as your Home or Mailing Address?"
    match: /address.*party.*paying|payer.*address.*same|address.*same.*home|address.*same.*mailing|same.*address.*paying/i,
    yesSelectors: ['input[id$="rblPayerAddrSameAsInd_0"]', 'input[id*="rblPayerAddrSameAsInd"][value="Y"]'],
    noSelectors:  ['input[id$="rblPayerAddrSameAsInd_1"]', 'input[id*="rblPayerAddrSameAsInd"][value="N"]'],
  },
]

/**
 * Try to find an element using DS-160 known ASP.NET ID patterns.
 */
async function findByKnownSelector(page, label) {
  if (!label) return null
  for (const { match, sel } of DS160_KNOWN) {
    if (match.test(label)) {
      // sel may be comma-separated; try each
      for (const s of sel.split(',').map(x => x.trim())) {
        try {
          const el = page.locator(s).first()
          // 2000ms is enough — faster failure when element is absent (avoids 4s × N stalls)
          await el.waitFor({ state: 'attached', timeout: 2000 })
          return el
        } catch { /* try next */ }
      }
    }
  }
  return null
}

function missingUiTarget(message) {
  const error = new Error(message)
  error.code = 'UI_TARGET_NOT_FOUND'
  return error
}

// ─── Element executor ────────────────────────────────────────────────────────

/**
 * Find an element by label / text using multiple Playwright strategies.
 * Returns the first locator that resolves to a visible element, or throws.
 */
async function findElement(page, { label, text, role, ref }) {
  // ── Fast path: planner-emitted ref resolves directly to an ASP.NET id ───────
  if (ref) {
    const FORM_PREFIX = 'ctl00_SiteContentPlaceHolder_FormView1_'
    const fullId = ref.includes('_SiteContentPlaceHolder_') ? ref : FORM_PREFIX + ref
    // The suffix match must be restricted to controls. Every field is shadowed
    // by a validator span sharing its name, so [id$="TRAVEL_DTE"] resolves to
    // CustomValTRAVEL_DTE — permanently invisible, leaving the action to wait
    // for it to become clickable until it times out.
    const controlMatch = ['input', 'select', 'textarea', 'button', 'a']
      .map((tag) => `${tag}[id$="${ref}"]`)
      .join(', ')
    for (const sel of [`#${fullId}`, controlMatch]) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'attached', timeout: 1500 })
        return el
      } catch { /* try next */ }
    }
    // ref didn't resolve — fall through to label strategies
  }

  const strategies = []

  if (label) {
    strategies.push(
      () => page.getByLabel(label, { exact: true }),
      () => page.getByLabel(label, { exact: false }),
      // Fallback: input/select near a <td> or <label> containing the text
      () => page.locator(`td:has-text("${label}") ~ td input`).first(),
      () => page.locator(`td:has-text("${label}") ~ td select`).first(),
      () => page.locator(`label:has-text("${label}") + input`).first(),
      () => page.locator(`label:has-text("${label}") + select`).first(),
      // Generic id/name partial match
      () => page.locator(`input[id*="${label.replace(/\s+/g,'')}" i], select[id*="${label.replace(/\s+/g,'')}" i]`).first(),
    )
  }

  if (text) {
    strategies.push(
      () => page.getByRole('button', { name: text, exact: false }),
      () => page.getByRole('link', { name: text, exact: false }),
      () => page.getByText(text, { exact: false }),
    )
  }

  if (role) {
    strategies.push(() => page.getByRole(role, { name: label || text, exact: false }))
  }

  // Try known DS-160 selectors first (most reliable)
  const known = await findByKnownSelector(page, label)
  if (known) return known

  for (const strat of strategies) {
    try {
      const el = strat()
      // 1500ms — faster failure when element is absent (was 3000ms × 7+ strategies = 21s stall)
      await el.waitFor({ state: 'visible', timeout: 1500 })
      return el
    } catch {
      // try next strategy
    }
  }

  // Payer-panel scoped fallback — when label mentions the payer, try getByLabel scoped
  // to the upnlPayer UpdatePanel.  The "first visible input" fallback is intentionally
  // removed: it always returned tbxPayerSurname regardless of which field was requested.
  if (label && /paying|payer/i.test(label)) {
    try {
      const panel = page.locator('#ctl00_SiteContentPlaceHolder_FormView1_upnlPayer, [id$="upnlPayer"]').first()
      if (await panel.count() > 0) {
        for (const exact of [true, false]) {
          try {
            const el = panel.getByLabel(label, { exact }).first()
            await el.waitFor({ state: 'visible', timeout: 1500 })
            return el
          } catch { /* try next */ }
        }
      }
    } catch { /* panel not found */ }
  }

  // Last-resort: scan table rows for a cell containing the label text,
  // then grab the first input/select in that row (CEAC often lacks <label for>).
  if (label) {
    const labelSnippet = label.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const rowSel of [
      `tr:has-text("${labelSnippet}")`,
      `tr:has(td:has-text("${labelSnippet}"))`,
    ]) {
      try {
        const row = page.locator(rowSel).first()
        await row.waitFor({ state: 'attached', timeout: 1000 })
        for (const inputSel of ['input[type="text"]', 'input[type="number"]', 'input:not([type])', 'select', 'textarea']) {
          try {
            const inp = row.locator(inputSel).first()
            await inp.waitFor({ state: 'visible', timeout: 800 })
            if (await inp.isDisabled().catch(() => false)) continue
            return inp
          } catch { /* try next */ }
        }
      } catch { /* try next */ }
    }

    try {
      const row = page.locator('tr').filter({ hasText: new RegExp(labelSnippet, 'i') }).first()
      const input = row.locator('input[type="text"], input:not([type]), input[type="password"]').first()
      await input.waitFor({ state: 'visible', timeout: 1500 })
      if (!(await input.isDisabled().catch(() => false))) return input
    } catch { /* continue */ }
  }

  throw missingUiTarget(`Element not found — label="${label}" text="${text}"`)
}

/**
 * Click the correct Yes/No radio button for a DS-160 question.
 *
 * DS-160 renders each question in a <tr> where the question text is in one <td>
 * and a RadioButtonList (Yes / No) is in the adjacent <td>.  Each radio has an
 * associated <label> whose text is exactly "Yes" or "No".
 *
 * Strategy:
 *   1. Find the <tr> (or nearest ancestor block) that contains the question label.
 *   2. Within that container, click the <label> whose text matches the desired value,
 *      which also activates the radio via the browser's native label-click behaviour.
 *   3. If step 2 fails, scan ALL radio inputs on the page, find those whose associated
 *      <label> text exactly matches "Yes"/"No", then pick the one whose nearest
 *      ancestor <tr>/<div> includes the question text.
 *   4. Last resort: Playwright getByLabel within the full page (least accurate).
 */
async function clickRadioByRef(page, ref, value) {
  const core = String(ref || '').replace(/_[01]$/, '')
  if (!/rbl/i.test(core)) return false
  const answer = String(value || '').trim()
  const index = /^no$/i.test(answer) ? 1 : /^y(?:es)?$/i.test(answer) ? 0 : -1
  if (index < 0) return false
  const radio = page.locator(`input[id$="FormView1_${core}_${index}"]`).first()
  if (!await radio.count()) return false
  await radio.scrollIntoViewIfNeeded().catch(() => {})
  if (!await radio.isChecked().catch(() => false)) await radio.click()
  log(`Radio clicked via ref: "${core}_${index}"`)
  return true
}

async function clickRadioForQuestion(page, questionLabel, value) {
  const isYes      = /^y(es)?$/i.test(value.trim())
  const targetText = isYes ? 'Yes' : 'No'

  // Helper: does a text string contain the first ~25 chars of the question?
  const containsQuestion = (txt) => txt && txt.includes(questionLabel.slice(0, 25))

  // ── Strategy 0: DS160_KNOWN_RADIOS — direct ASP.NET ID lookup (most reliable) ─
  for (const { match, yesSelectors, noSelectors } of DS160_KNOWN_RADIOS) {
    if (!match.test(questionLabel)) continue
    const selectors = isYes ? yesSelectors : noSelectors
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'attached', timeout: 3000 })
        await el.scrollIntoViewIfNeeded().catch(() => {})
        if (await el.isChecked().catch(() => false)) {
          log(`Radio already selected via DS160_KNOWN_RADIOS: "${sel}"`)
          return
        }
        await el.click()
        log(`Radio clicked via DS160_KNOWN_RADIOS: "${sel}"`)
        return
      } catch { /* try next */ }
    }
  }

  // ── Strategy 1: <tr> or <div> ancestor that contains the question text ──────
  for (const containerSel of [
    `tr:has-text("${questionLabel.slice(0, 30)}")`,
    `div:has-text("${questionLabel.slice(0, 30)}")`,
    `td:has-text("${questionLabel.slice(0, 30)}")`,
  ]) {
    try {
      const container = page.locator(containerSel).first()
      await container.waitFor({ state: 'attached', timeout: 2000 })
      // Click the label inside the container whose text is "Yes" or "No"
      const lbl = container.locator(`label:has-text("${targetText}")`).first()
      if (await lbl.count() > 0) {
        await lbl.scrollIntoViewIfNeeded().catch(() => {})
        await lbl.click()
        return
      }
      // Try radio value attribute Y/N
      const radioVal = isYes ? 'Y' : 'N'
      const radio = container.locator(`input[type="radio"][value="${radioVal}"]`).first()
      if (await radio.count() > 0) {
        await radio.scrollIntoViewIfNeeded().catch(() => {})
        await radio.click()
        return
      }
    } catch { /* try next */ }
  }

  // ── Strategy 2: Scan all labels on the page matching "Yes"/"No", pick the ──
  //               one whose ancestor row contains the question text.
  const allLabels = await page.locator(`label`).all()
  for (const lbl of allLabels) {
    try {
      const lblText = (await lbl.textContent())?.trim()
      if (lblText?.toLowerCase() !== targetText.toLowerCase()) continue
      // Walk up 3 levels looking for a row/container with the question
      for (const xpath of ['..', '../..', '../../..', '../../../..']) {
        try {
          const ancestor = lbl.locator(`xpath=${xpath}`)
          const ancestorText = await ancestor.textContent({ timeout: 500 })
          if (containsQuestion(ancestorText)) {
            await lbl.scrollIntoViewIfNeeded().catch(() => {})
            await lbl.click()
            return
          }
        } catch { /* keep walking */ }
      }
    } catch { /* skip */ }
  }

  // ── Strategy 3: Scan radio inputs whose value attribute is Y/N ──────────────
  const targetVal = isYes ? 'Y' : 'N'
  const allRadios = await page.locator(`input[type="radio"][value="${targetVal}"]`).all()
  for (const radio of allRadios) {
    try {
      for (const xpath of ['..', '../..', '../../..', '../../../..']) {
        const ancestor = radio.locator(`xpath=${xpath}`)
        const ancestorText = await ancestor.textContent({ timeout: 500 }).catch(() => '')
        if (containsQuestion(ancestorText)) {
          await radio.scrollIntoViewIfNeeded().catch(() => {})
          await radio.click()
          return
        }
      }
    } catch { /* skip */ }
  }

  // Do not use an unscoped getByLabel("Yes"/"No") fallback here. When a source
  // question is absent from this page it would click the first unrelated radio.
  throw missingUiTarget(`Radio not found for question="${questionLabel}" value="${value}"`)
}

/**
 * Execute a single agent action on the Playwright page.
 * Throws if the action is a blocked submission attempt.
 */
function normalizedPhoneDigits(value) {
  return phoneDigits(value)
}

async function prepareAddressPhoneForNavigation(page) {
  const primary = page.locator('input[id$="tbxAPP_HOME_TEL"]').first()
  if (!await primary.count()) return

  const seen = new Set()
  const primaryDigits = normalizedPhoneDigits(await primary.inputValue().catch(() => ''))
  if (primaryDigits) seen.add(primaryDigits)

  const optionalPhones = [
    {
      name: 'Secondary Phone Number',
      input: page.locator('input[id$="tbxAPP_MOBILE_TEL"]').first(),
      checkbox: page.locator('input[id$="cbexAPP_MOBILE_TEL_NA"]').first(),
    },
    {
      name: 'Work Phone Number',
      input: page.locator('input[id$="tbxAPP_BUS_TEL"]').first(),
      checkbox: page.locator('input[id$="cbexAPP_BUS_TEL_NA"]').first(),
    },
  ]

  for (const field of optionalPhones) {
    const value = await field.input.inputValue().catch(() => '')
    const digits = normalizedPhoneDigits(value)
    const duplicate = Boolean(digits && seen.has(digits))
    if (!digits || duplicate) {
      if (duplicate) {
        await field.input.fill('').catch(() => {})
        log(`Removed duplicate ${field.name}: "${value}"`)
      }
      if (!await field.checkbox.isChecked().catch(() => false)) {
        await field.checkbox.click()
        log(`Checked "Does Not Apply" for ${field.name}`)
      }
    } else {
      seen.add(digits)
    }
  }

  const additionalInputs = page.locator(
    'input[id*="dtlAddPhone"][id*="tbxAddPhoneInfo"]:visible',
  )
  const additionalCount = await additionalInputs.count()
  if (additionalCount) {
    let validAdditionalCount = 0
    for (let index = 0; index < additionalCount; index++) {
      const digits = normalizedPhoneDigits(
        await additionalInputs.nth(index).inputValue().catch(() => ''),
      )
      if (digits && !seen.has(digits)) {
        seen.add(digits)
        validAdditionalCount++
      }
    }
    if (validAdditionalCount === 0) {
      const noOtherPhones = page.locator('input[id$="rblAddPhone_1"]').first()
      if (!await noOtherPhones.isChecked().catch(() => false)) {
        await noOtherPhones.click()
        await page.waitForTimeout(800)
        log('Removed blank/duplicate additional-phone rows by selecting No')
      }
    }
  }
}

export async function executeAction(page, action) {
  const { type, label, text, ref } = action
  let { value } = action
  // Repeated DS-160 controls use the same visible label in every row. Actions
  // can specify a 1-based occurrence so we target the intended row.
  const occurrence = Math.max(1, Number.parseInt(action.occurrence, 10) || 1)

  if (await routePayerCompanyField(page, action)) {
    return
  }

  if (
    expectedPayerCompany?.street1 &&
    type === 'fill' &&
    /street address \(line 1\)/i.test(String(label || '')) &&
    !/payer company/i.test(String(label || '')) &&
    String(value || '').trim().toUpperCase() === expectedPayerCompany.street1.trim().toUpperCase()
  ) {
    log('Skipped payer street on the U.S. stay address')
    return
  }

  if (await routePersonal1BirthStateDoesNotApply(page, action)) {
    return
  }

  if (await routeUSContactOrganizationMarker(page, action)) {
    return
  }

  if (await routeUSContactPersonNameMarker(page, action)) {
    return
  }

  // General safety net: a "not applicable" answer is never a field value. Tick
  // the field's Does Not Apply box if it has one, otherwise leave it blank.
  // Selects are included: "N/A" is not one of their options, so choosing it
  // either throws or silently leaves the placeholder selected.
  // Social Media Provider/Platform is the exception: CEAC's real option is "NONE".
  if (
    (type === 'fill' || type === 'selectOption') &&
    typeof value === 'string' &&
    // An empty value is left alone, since clearing a field is a legitimate
    // correction, whereas "N/A", "None" and "Not Relevant" are answers.
    value.trim() !== '' &&
    isMarkerValue(value) &&
    !(
      type === 'selectOption' &&
      /^social media provider\/platform$/i.test(String(label || '').trim()) &&
      /^none$/i.test(value.trim())
    )
  ) {
    const markerLabel = String(label || action.fieldLabel || '').trim()
    if (markerLabel) {
      const handled = await checkDoesNotApplyFor(page, markerLabel, occurrence)
      if (handled) {
        log(`Marker value "${value}" → checked Does Not Apply for "${markerLabel}"`)
        return
      }
    }
    log(`Skipping ${type} of marker value "${value}" for "${markerLabel}" — left blank`)
    return
  }

  // The duties field is required for occupations that render it. If the
  // translated source has no description, use a minimal occupation-aware
  // fallback rather than leaving the required field blank or entering "N/A".
  if (
    type === 'fill' &&
    /briefly.*describe.*duties|describe.*(?:your )?duties|^duties$/i.test(label || '') &&
    (typeof value !== 'string' || /^(?:\s*|n\/?a|not available|unknown)$/i.test(value))
  ) {
    const occupation = await page.locator('select[id$="ddlPresentOccupation"]').first()
      .locator('option:checked').textContent().catch(() => '')
    value = /student/i.test(occupation || '')
      ? 'Studying'
      : 'Performing the regular duties associated with my position.'
    log(`Using default duties description: "${value}"`)
  }

  if (
    type === 'fill' &&
    await routeWorkPreviousCityFill(page, label, value, occurrence, ref)
  ) {
    return
  }

  if (
    type === 'fill' &&
    typeof value === 'string' &&
    await routeWorkEducationMarkerToCheckbox(page, label, value, occurrence)
  ) {
    return
  }

  if (
    type === 'fill' &&
    /phone/i.test(label || '') &&
    String(value || '').replace(/\D/g, '') === '5555555555' &&
    await page.locator('input[id$="tbxUS_POC_HOME_TEL"]').count() > 0
  ) {
    throw new Error('Refusing to fill the U.S. contact phone with the DS-160 example value 5555555555')
  }

  // DS-160 phone inputs expect digits only. Formatting such as
  // "+972 538055645" can exceed maxlength and is rejected by the form.
  if (type === 'fill' && typeof value === 'string') {
    const normalized = normalizePhoneFillValue(value, {
      label,
      fieldLabel: action.fieldLabel,
      ref,
    })
    if (normalized !== value) {
      log(`Normalized phone number "${value}" → "${normalized}"`)
      value = normalized
    }
    const named = normalizeCeacNameFillValue(value, {
      label,
      fieldLabel: action.fieldLabel,
      ref,
    })
    if (named !== value) {
      log(`Normalized CEAC name "${value}" → "${named}"`)
      value = named
    }
    const limitLabel = limitForTranslatedLabel(label) ? label : action.fieldLabel
    const limit = limitForTranslatedLabel(limitLabel)
    if (limit) {
      const shortened = /phone|telephone/i.test(String(limitLabel || ''))
        ? fitDs160Phone(value, limit)
        : fitDs160Value(value, limit, { city: isTranslatedCityLabel(limitLabel) })
      if (shortened !== value) {
        log(`Shortened "${limitLabel}" "${value}" → "${shortened}"`)
        value = shortened
      }
    }
  }

  // Travel "Street Address (Line 1)" is maxlength=40. Packed
  // "street, city, ST ZIP, United States" values get truncated (e.g. ZIP 3302).
  if (
    type === 'fill' &&
    typeof value === 'string' &&
    /street address(?:\s*\(line 1\))?$/i.test(String(label || '').trim())
  ) {
    const stayStreet = page.locator('input[id$="tbxStreetAddress1"]').first()
    if (await stayStreet.count() > 0) {
      const packed = parsePackedUsAddress(value)
      if (packed.street && packed.street !== value.trim()) {
        log(`Split packed U.S. stay address "${value}" → street "${packed.street}"`)
        value = packed.street
        await fillEmptyTravelStayParts(page, packed)
      }
    }
  }

  // ⛔ Hard block — never submit the form
  if (isBlockedSubmissionClick({ type, text })) {
    throw new Error(
      `⛔ BLOCKED: Attempted to click "${text}" directly — final submission must use the guarded submitApplication action.`,
    )
  }

  if (
    type === 'fillDate' ||
    (
      type === 'fill' &&
      /\d{1,2}\/\d{1,2}\/\d{4}/.test(value) &&
      /date|attendance\s+(?:from|to)|service\s+(?:from|to)/i.test(label)
    )
  ) {
    // DS-160 date fields use three separate Day/Month/Year inputs.
    // Parse DD/MM/YYYY (also handles MM/DD/YYYY based on context).
    const parts = value.split('/')
    let day, month, year
    if (parts.length === 3) {
      // translated.txt dates are DD/MM/YYYY
      ;[day, month, year] = parts
    } else {
      throw new Error(`Cannot parse date value: "${value}"`)
    }
    day   = day.padStart(2, '0')
    month = month.padStart(2, '0')

    const MONTH_NAMES  = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December']
    const MONTH_ABBREVS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
    const monthIndex  = parseInt(month, 10) - 1
    const monthName   = MONTH_NAMES[monthIndex]
    const monthAbbrev = MONTH_ABBREVS[monthIndex]

    // The inventory reports the exact three control ids for every date group it
    // finds, so when the caller passes them along there is nothing to infer. The
    // label heuristics below only exist for the planner, which sees labels.
    if (action.dateParts) {
      const { day: dayId, month: monthId, year: yearId } = action.dateParts
      const daySelect = await findElement(page, { ref: dayId })
      const monthSelect = await findElement(page, { ref: monthId })
      const yearInput = await findElement(page, { ref: yearId })

      // Month options are "JAN" on most pages but full names on a few, so pick
      // whichever spelling this particular select actually offers.
      const monthOptions = await monthSelect.locator('option').allTextContents()
      const monthOption =
        [monthAbbrev, monthName, month, String(monthIndex + 1)].find((candidate) =>
          monthOptions.some((text) => text.trim().toUpperCase() === candidate.toUpperCase()),
        ) || monthAbbrev

      await daySelect.selectOption({ label: String(parseInt(day, 10)) }).catch(
        async () => { await daySelect.selectOption(day) },
      )
      await monthSelect.selectOption({ label: monthOption }).catch(
        async () => { await monthSelect.selectOption(monthOption) },
      )
      await yearInput.fill(year)
      log(`Filled date "${label}" = ${day}/${month}/${year} via ${dayId}`)
      return
    }

    // Determine field selectors based on label context
    const isSpouseDOB    = /spouse/i.test(label)
    const isFatherDOB    = /father/i.test(label)
    const isMotherDOB    = /mother/i.test(label)
    const isPreviousTravelPage =
      await page.locator('input[id$="rblPREV_US_TRAVEL_IND_0"]').count() > 0
    const isPreviousVisitDate =
      /previous.*(?:visit|u\.?s).*date|(?:visit|u\.?s).*arrival.*date/i.test(label) ||
      (isPreviousTravelPage && /^date arrived$/i.test(label || ''))
    const isArrivalDate  = /arrival|intended.*date|date.*arrival/i.test(label)
    const isPreviousVisaIssue = /date last visa was issued|previous visa.*issu/i.test(label)
    const isEmploymentStartDate = /^start date$|employment.*start.*date|start.*date.*employment|emp.*date.*from/i.test(label)
    const isEmploymentEndDate = /^end date$|employment.*(?:end.*date|date.*to)|emp.*date.*to/i.test(label)
    const isEducationStartDate = /attendance\s+from|date of attendance from/i.test(label)
    const isEducationEndDate = /attendance\s+to|date of attendance to/i.test(label)
    const isMilitaryStartDate =
      /^(?:date of )?service from$|military.*service.*from/i.test(label)
    const isMilitaryEndDate =
      /^(?:date of )?service to$|military.*service.*to/i.test(label)
    const isPassportIss  = /issu/i.test(label)
    const isPassportExp  = /expir/i.test(label)

    let daySelectors, monthSelectors, yearSelectors

    if (isPreviousVisitDate) {
      // Previous U.S. visits are repeatable. ASP.NET adds a row index to the
      // surrounding id, while preserving these stable field-name fragments.
      daySelectors = [
        'select[id*="PREV_US_VISIT_DTE"][id*="Day"]',
        'select[id*="PREV_US_VISIT"][id*="DTEDay"]',
      ]
      monthSelectors = [
        'select[id*="PREV_US_VISIT_DTE"][id*="Month"]',
        'select[id*="PREV_US_VISIT"][id*="DTEMonth"]',
      ]
      yearSelectors = [
        'input[id*="PREV_US_VISIT_DTE"][id*="Year"]',
        'input[id*="PREV_US_VISIT"][id*="DTEYear"]',
      ]
    } else if (isArrivalDate) {
      // Intended Date of Arrival or Date of Arrival in U.S.
      // Actual IDs (confirmed from DOM snapshot): ddlARRIVAL_US_DTEDay/Month, tbxARRIVAL_US_DTEYear
      // Also covers the "Not Known" path: ddlTRAVEL_DTEDay/Month, tbxTRAVEL_DTEYear
      daySelectors   = [
        'select[id*="ARRIVAL_US_DTEDay"]',
        'select[id$="ddlTRAVEL_DTEDay"]',
        'select[id*="ddlTravelDayOfArrival"]',
        'select[id*="ArrivalDay"]',
        'select[id*="DTEDay"]',
      ]
      monthSelectors = [
        'select[id*="ARRIVAL_US_DTEMonth"]',
        'select[id$="ddlTRAVEL_DTEMonth"]',
        'select[id*="ddlTravelMonthOfArrival"]',
        'select[id*="ArrivalMonth"]',
        'select[id*="DTEMonth"]',
      ]
      yearSelectors  = [
        'input[id*="ARRIVAL_US_DTEYear"]',
        'input[id$="tbxTRAVEL_DTEYear"]',
        'input[id*="tbxTravelYearOfArrival"]',
        'input[id*="ArrivalYear"]',
        'input[id*="DTEYear"]',
      ]
    } else if (isEmploymentStartDate) {
      daySelectors = ['select[id$="ddlEmpDateFromDay"]']
      monthSelectors = ['select[id$="ddlEmpDateFromMonth"]']
      yearSelectors = ['input[id$="tbxEmpDateFromYear"]']
    } else if (isEmploymentEndDate) {
      daySelectors = ['select[id$="ddlEmpDateToDay"]']
      monthSelectors = ['select[id$="ddlEmpDateToMonth"]']
      yearSelectors = ['input[id$="tbxEmpDateToYear"]']
    } else if (isEducationStartDate) {
      daySelectors = ['select[id$="ddlSchoolFromDay"]']
      monthSelectors = ['select[id$="ddlSchoolFromMonth"]']
      yearSelectors = ['input[id$="tbxSchoolFromYear"]']
    } else if (isEducationEndDate) {
      daySelectors = ['select[id$="ddlSchoolToDay"]']
      monthSelectors = ['select[id$="ddlSchoolToMonth"]']
      yearSelectors = ['input[id$="tbxSchoolToYear"]']
    } else if (isMilitaryStartDate) {
      daySelectors = ['select[id$="ddlMILITARY_SVC_FROMDay"]']
      monthSelectors = ['select[id$="ddlMILITARY_SVC_FROMMonth"]']
      yearSelectors = ['input[id$="tbxMILITARY_SVC_FROMYear"]']
    } else if (isMilitaryEndDate) {
      daySelectors = ['select[id$="ddlMILITARY_SVC_TODay"]']
      monthSelectors = ['select[id$="ddlMILITARY_SVC_TOMonth"]']
      yearSelectors = ['input[id$="tbxMILITARY_SVC_TOYear"]']
    } else if (isPreviousVisaIssue) {
      daySelectors = ['select[id$="ddlPREV_VISA_ISSUED_DTEDay"]']
      monthSelectors = ['select[id$="ddlPREV_VISA_ISSUED_DTEMonth"]']
      yearSelectors = ['input[id$="tbxPREV_VISA_ISSUED_DTEYear"]']
    } else if (isPassportIss) {
      // Passport Issuance Date: Day=select, Month=select (3-letter: JAN…DEC), Year=text input
      daySelectors   = [
        'select[id$="ddlPPT_ISSUED_DTEDay"]',
        'select[id*="PassIss"][id*="Day"]',
        'select[id*="PPT_ISSUE_DTE_DAY"]',
        'select[id*="PassIssDt"][id*="Day"]',
      ]
      monthSelectors = [
        'select[id$="ddlPPT_ISSUED_DTEMonth"]',
        'select[id*="PassIss"][id*="Month"]',
        'select[id*="PPT_ISSUE_DTE_MONTH"]',
        'select[id*="PassIssDt"][id*="Month"]',
      ]
      yearSelectors  = [
        'input[id$="tbxPPT_ISSUEDYear"]',
        'input[id*="PassIss"][id*="Year"]',
        'input[id*="PPT_ISSUE_DTE_YEAR"]',
        'input[id*="PassIssDt"][id*="Year"]',
        'input[id$="tbxPassIssDt"]',
      ]
    } else if (isPassportExp) {
      // Passport Expiry Date: Day=select, Month=select (3-letter: JAN…DEC), Year=text input
      daySelectors   = [
        'select[id$="ddlPPT_EXPIRE_DTEDay"]',
        'select[id*="PassExp"][id*="Day"]',
        'select[id*="PPT_EXPIRE_DTE_DAY"]',
        'select[id*="PassExpDt"][id*="Day"]',
      ]
      monthSelectors = [
        'select[id$="ddlPPT_EXPIRE_DTEMonth"]',
        'select[id*="PassExp"][id*="Month"]',
        'select[id*="PPT_EXPIRE_DTE_MONTH"]',
        'select[id*="PassExpDt"][id*="Month"]',
      ]
      yearSelectors  = [
        'input[id$="tbxPPT_EXPIREYear"]',
        'input[id*="PassExp"][id*="Year"]',
        'input[id*="PPT_EXPIRE_DTE_YEAR"]',
        'input[id*="PassExpDt"][id*="Year"]',
        'input[id$="tbxPassExpDt"]',
      ]
    } else {
      // Father DOB IDs from DOM: ddlFathersDOBDay / ddlFathersDOBMonth / tbxFathersDOBYear
      // Mother DOB IDs from DOM: ddlMothersDOBDay / ddlMothersDOBMonth / tbxMothersDOBYear
      if (isFatherDOB) {
        daySelectors   = ['select[id$="ddlFathersDOBDay"]',   'select[id$="FthrDOBDay"]',   'select[id*="Father"][id*="Day"]']
        monthSelectors = ['select[id$="ddlFathersDOBMonth"]', 'select[id$="FthrDOBMonth"]', 'select[id*="Father"][id*="Month"]']
        yearSelectors  = ['input[id$="tbxFathersDOBYear"]',   'input[id$="FthrDOBYear"]',   'input[id*="Father"][id*="Year"]']
      } else if (isMotherDOB) {
        daySelectors   = ['select[id$="ddlMothersDOBDay"]',   'select[id$="MthrDOBDay"]',   'select[id*="Mother"][id*="Day"]']
        monthSelectors = ['select[id$="ddlMothersDOBMonth"]', 'select[id$="MthrDOBMonth"]', 'select[id*="Mother"][id*="Month"]']
        yearSelectors  = ['input[id$="tbxMothersDOBYear"]',   'input[id$="MthrDOBYear"]',   'input[id*="Mother"][id*="Year"]']
      } else {
        const dayIdHint   = isSpouseDOB ? 'SpsDOBDay'   : 'DOBDay'
        const monthIdHint = isSpouseDOB ? 'SpsDOBMonth' : 'DOBMonth'
        const yearIdHint  = isSpouseDOB ? 'SpsDOBYear'  : 'DOBYear'
        daySelectors   = [`input[id$="${dayIdHint}"]`,   `select[id$="${dayIdHint}"]`,   'input[id$="tbxDOBDay"]',   'select[id$="ddlDOBDay"]']
        monthSelectors = [`select[id$="${monthIdHint}"]`, `input[id$="${monthIdHint}"]`, 'select[id$="ddlDOBMonth"]', 'input[id$="tbxDOBMonth"]']
        yearSelectors  = [`input[id$="${yearIdHint}"]`,   `select[id$="${yearIdHint}"]`, 'input[id$="tbxDOBYear"]',  'select[id$="ddlDOBYear"]']
      }
    }

    async function setDateField(selectors, ...candidates) {
      const vals = candidates.filter(Boolean)
      for (const sel of selectors) {
        try {
          const matches = page.locator(sel)
          if (await matches.count() < occurrence) continue
          const el = matches.nth(occurrence - 1)
          // 2000ms — faster failure on absent elements (was 4000ms × 5 selectors = 20s stall)
          await el.waitFor({ state: 'attached', timeout: 2000 })
          const tag = await el.evaluate(e => e.tagName.toLowerCase())
          if (tag === 'select') {
            const fast = { timeout: 1500 }
            for (const v of vals) {
              // Try value first (DS-160 uses canonical codes as both value and text)
              try { await el.selectOption({ value: v }, fast); return } catch {}
              try { await el.selectOption({ label: v }, fast); return } catch {}
            }
          } else {
            await el.fill(vals[0])
            return
          }
        } catch { /* try next selector */ }
      }
      return null // signal: not found via named selectors
    }

    // Month-specific fallback: find any visible <select> whose options look like month names or abbrevs
    async function findMonthSelectByOptions() {
      const allSelects = await page.locator('select').all()
      const monthSelects = []
      for (const sel of allSelects) {
        try {
          if (!await sel.isVisible()) continue
          const opts = await sel.locator('option').all()
          if (opts.length < 10) continue
          const texts = await Promise.all(opts.slice(1, 4).map(o => o.textContent()))
          const looksLikeMonths = texts.some(t => /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(t || ''))
          if (looksLikeMonths) monthSelects.push(sel)
        } catch { /* skip */ }
      }
      return monthSelects[occurrence - 1] || null
    }

    // Day: try plain number ("10") first (DS-160 option value is "10" not "10-padded"), then zero-padded
    const dayResult   = await setDateField(daySelectors, parseInt(day, 10).toString(), day)
    // Month: DS-160 stores value="9" text="SEP" — try numeric value FIRST (instant match),
    // then abbrev label, then full name. Zero-padded "09" is tried last as it rarely matches.
    let monthResult = await setDateField(
      monthSelectors,
      parseInt(month, 10).toString(),  // "9" → hits value="9" instantly
      monthAbbrev,                     // "SEP" → hits label="SEP"
      monthName,                       // "September" → full name fallback
      month,                           // "09" → rarely matches
    )

    if (monthResult === null) {
      // Fallback: find month select by scanning option text content
      const monthSel = await findMonthSelectByOptions()
      if (monthSel) {
        const fast = { timeout: 1500 }
        // value-based is most reliable since option values ARE the 3-letter codes
        try {
          await monthSel.selectOption({ value: monthAbbrev }, fast)
          monthResult = true
          log(`Month set via value fallback: "${monthAbbrev}"`)
        }
        catch {
          try { await monthSel.selectOption({ label: monthAbbrev }, fast); monthResult = true } catch {}
          if (monthResult === null) {
            try { await monthSel.selectOption({ label: monthName }, fast); monthResult = true } catch {}
          }
          if (monthResult === null) {
            try { await monthSel.selectOption({ value: month }, fast); monthResult = true } catch {}
          }
          log(`Month set via option-content fallback: "${monthAbbrev}"`)
        }
      } else {
        throw new Error(`Date sub-field (month) not found — tried: ${monthSelectors.join(', ')} and option-content scan`)
      }
    }

    const yearResult = await setDateField(yearSelectors, year, year)
    if (
      (isPreviousVisitDate || isMilitaryStartDate || isMilitaryEndDate) &&
      (dayResult === null || monthResult === null || yearResult === null)
    ) {
      throw new Error(`Date field "${label}" row ${occurrence} was not found or could not be completed`)
    }
    return
  }

  if (type === 'fill') {
    if (/passport\/travel document number/i.test(label || '')) {
      const passportInput = page.locator('#ctl00_SiteContentPlaceHolder_PPTNumTbx').first()
      if (await passportInput.isVisible({ timeout: 500 }).catch(() => false)) {
        await passportInput.fill(String(value || '').trim())
        return
      }
    }

    if (/^year$/i.test((label || '').trim())) {
      const lostVisaYear = page.locator('input[id$="tbxPREV_VISA_LOST_YEAR"]').first()
      if (await lostVisaYear.isVisible({ timeout: 500 }).catch(() => false)) {
        await lostVisaYear.fill(String(value || ''))
        return
      }
    }

    if (/^explain$/i.test((label || '').trim())) {
      const previousTravelExplanations = page.locator(
        'textarea[id$="tbxPREV_VISA_LOST_EXPL"], ' +
        'textarea[id$="tbxPREV_VISA_CANCELLED_EXPL"], ' +
        'textarea[id$="tbxPREV_VISA_REFUSED_EXPL"], ' +
        'textarea[id$="tbxIV_PETITION_EXPL"]',
      )
      const count = await previousTravelExplanations.count()
      for (let index = 0; index < count; index++) {
        const candidate = previousTravelExplanations.nth(index)
        if (
          await candidate.isVisible().catch(() => false) &&
          !(await candidate.inputValue().catch(() => '')).trim()
        ) {
          await candidate.fill(String(value || ''))
          return
        }
      }
    }

    if (
      /^country$|^name of country\/region$/i.test((label || '').trim()) &&
      await page.locator(
        'select[id*="dtlMILITARY_SERVICE"][id*="ddlMILITARY_SVC_CNTRY"]',
      ).count() > 0
    ) {
      return executeAction(page, {
        type: 'selectOption',
        label: 'Military Service Country',
        value,
        occurrence,
      })
    }

    const repeatedFill = [
      {
        match: /^language name$/i,
        selector: 'input[id*="dtlLANGUAGES"][id*="tbxLANGUAGE_NAME"]',
      },
      {
        match: /^organization name$/i,
        selector: 'input[id*="dtlORGANIZATIONS"][id*="tbxORGANIZATION_NAME"]',
        contextSelector: 'input[id*="rblORGANIZATION_IND"]',
      },
      {
        match: /^branch of service$/i,
        selector: 'input[id*="dtlMILITARY_SERVICE"][id*="tbxMILITARY_SVC_BRANCH"]',
      },
      {
        match: /^rank\s*\/\s*position$/i,
        selector: 'input[id*="dtlMILITARY_SERVICE"][id*="tbxMILITARY_SVC_RANK"]',
      },
      {
        match: /^military specialty$/i,
        selector: 'input[id*="dtlMILITARY_SERVICE"][id*="tbxMILITARY_SVC_SPECIALTY"]',
      },
      {
        match: /^additional email address$/i,
        selector: 'input[id*="dtlAddEmail"][id*="tbxAddEmailInfo"]',
      },
      {
        match: /^social media identifier$/i,
        selector: 'input[id*="dtlSocial"][id*="tbxSocialMediaIdent"]',
        waitUntilEnabled: true,
      },
      {
        match: /driver.?s license number/i,
        selector: 'input[id*="dtlUS_DRIVER_LICENSE"][id*="tbxUS_DRIVER_LICENSE"]',
      },
    ].find((entry) => entry.match.test((label || '').trim()))
    if (
      repeatedFill &&
      (!repeatedFill.contextSelector || await page.locator(repeatedFill.contextSelector).count() > 0)
    ) {
      const inputs = page.locator(repeatedFill.selector)
      if (await inputs.count() < occurrence) {
        throw new Error(`Repeated field "${label}" row ${occurrence} was not found`)
      }
      const input = inputs.nth(occurrence - 1)
      await input.waitFor({ state: 'visible', timeout: 5000 })
      if (repeatedFill.waitUntilEnabled) {
        const enabled = await waitUntilInputEnabled(page, input, 10_000)
        if (!enabled) {
          throw new Error(`"${label}" stayed disabled after waiting for the platform postback`)
        }
      }
      await input.fill(String(value || ''))
      return
    }

    // The U.S. Point of Contact email "Does Not Apply" checkbox may be checked
    // by default, which disables the email input. Only uncheck it when we have
    // an actual email value to fill.
    if (
      typeof value === 'string' &&
      value.trim() &&
      /point.*contact.*email|u\.?s\.?.*contact.*email|^email address$/i.test(label || '')
    ) {
      const contactEmail = page.locator('input[id$="tbxUS_POC_EMAIL_ADDR"]').first()
      const contactEmailNA = page.locator('input[id$="cbexUS_POC_EMAIL_ADDR_NA"]').first()
      if (
        await contactEmail.count() > 0 &&
        await contactEmailNA.isChecked().catch(() => false)
      ) {
        await contactEmailNA.click()
        await page.waitForTimeout(300)
        log('Unchecked U.S. contact email "Does Not Apply" before filling')
      }
    }

    // Lost/stolen passport details are repeatable rows.
    if (/^lost passport\/travel document number$|^lost passport explanation$/i.test((label || '').trim())) {
      const selector = /explanation/i.test(label)
        ? 'textarea[id*="dtlLostPPT"][id*="tbxLOST_PPT_EXPL"]'
        : 'input[id*="dtlLostPPT"][id*="tbxLOST_PPT_NUM"]'
      const fields = page.locator(selector)
      if (await fields.count() < occurrence) {
        throw new Error(`Lost-passport row ${occurrence} was not found for "${label}"`)
      }
      const field = fields.nth(occurrence - 1)
      await field.scrollIntoViewIfNeeded().catch(() => {})
      await field.fill(value)
      return
    }

    // Additional phone numbers are repeatable rows on Address and Phone.
    if (/^additional phone number$/i.test((label || '').trim())) {
      const inputs = page.locator('input[id*="dtlAddPhone"][id*="tbxAddPhoneInfo"]')
      if (await inputs.count() < occurrence) {
        throw new Error(`Additional phone-number row ${occurrence} was not found`)
      }
      const input = inputs.nth(occurrence - 1)
      await input.scrollIntoViewIfNeeded().catch(() => {})
      await input.fill(value)
      return
    }

    // Previous-visit length of stay is repeatable, unlike the intended-stay
    // field on Travel Information. Select the requested row directly.
    if (/previous.*(?:visit|u\.?s).*length.*stay|(?:visit|u\.?s).*stay.*length/i.test(label || '')) {
      const inputs = page.locator(
        'input[type="text"][id*="tbxPREV_US_VISIT_LOS"], input[type="number"][id*="PREV_US_VISIT"][id*="LOS"]',
      )
      if (await inputs.count() < occurrence) {
        throw new Error(`Previous visit length-of-stay row ${occurrence} was not found`)
      }
      const input = inputs.nth(occurrence - 1)
      await input.scrollIntoViewIfNeeded().catch(() => {})
      await input.fill(value)
      return
    }

    // For native alphabet field: uncheck "Does Not Apply" first if it's checked,
    // because a checked checkbox disables the input making fill silently fail.
    if (/native alphabet/i.test(label || '')) {
      try {
        const cb = page.locator('input[type="checkbox"]').filter({ hasText: '' }).locator('xpath=../..').locator('input[type="checkbox"]')
        // Simpler: find checkbox near the native alphabet input
        const nativeCb = page.locator('input[id$="cbexAPP_FULL_NAME_NATIVE_NA"], input[id$="cbxAPP_FULL_NAME_NATIVE"], input[id*="FULL_NAME_NATIVE"][type="checkbox"]').first()
        if (await nativeCb.isChecked().catch(() => false)) {
          await nativeCb.uncheck()
          await page.waitForTimeout(300)
          log('Unchecked "Does Not Apply" on native alphabet field')
        } else {
          // Broader: any visible checked checkbox near "Does Not Apply" text on this field
          const checkboxes = await page.locator('input[type="checkbox"]:checked').all()
          for (const c of checkboxes) {
            const pText = await c.locator('xpath=../..').textContent().catch(() => '')
            if (/does not apply|technology not available/i.test(pText)) {
              await c.uncheck()
              await page.waitForTimeout(300)
              log('Unchecked "Does Not Apply" on native alphabet field')
              break
            }
          }
        }
      } catch { /* continue */ }
    }

    // ── Payer sub-field direct fill ──────────────────────────────────────────
    // findElement can return a <select> for these labels due to fallback ambiguity.
    // Bypass it entirely for payer text inputs: use confirmed ASP.NET id$= selectors
    // with an 8-second timeout so the UpdatePanel AJAX has time to render after
    // selecting "Other Person" from the who-is-paying dropdown.
    {
      const PAYER_FILL_MAP = [
        { match: /surname.*person.*paying|surnames.*paying|payer.*surname/i,
          id: 'tbxPayerSurname' },
        { match: /given.*name.*person.*paying|given.*names.*paying|payer.*given/i,
          id: 'tbxPayerGivenName' },
        { match: /phone.*person.*paying|phone.*paying|payer.*phone|^telephone number$/i,
          id: 'tbxPayerPhone' },
        { match: /email.*person.*paying|email.*paying|payer.*email/i,
          id: 'tbxPAYER_EMAIL_ADDR' },
      ]
      for (const { match, id } of PAYER_FILL_MAP) {
        if (!match.test(label || '')) continue

        // For email: uncheck "Does Not Apply" first so the input is enabled
        if (id === 'tbxPAYER_EMAIL_ADDR') {
          try {
            const dna = page.locator('input[id$="cbxDNAPAYER_EMAIL_ADDR_NA"]').first()
            if (await dna.count() > 0 && await dna.isChecked().catch(() => false)) {
              await dna.click()
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
              await page.waitForTimeout(300)
              log('Unchecked "Does Not Apply" on payer email — field enabled')
            }
          } catch { /* not present */ }
        }

        try {
          const directEl = page.locator(`input[id$="${id}"]`).first()
          await directEl.waitFor({ state: 'visible', timeout: 8000 })
          await directEl.scrollIntoViewIfNeeded().catch(() => {})
          await directEl.click()
          await directEl.fill(value)
          const actual = await directEl.inputValue().catch(() => '')
          if (!actual && value) await page.keyboard.type(value, { delay: 30 })
          log(`✅ Payer field filled directly: ${id} = "${value}"`)
          return
        } catch (err) {
          log(`⚠️  Direct payer fill failed for ${id}: ${err.message?.slice(0, 80)} — falling through`)
        }
        break // tried the matching entry; don't fall to generic path silently
      }
    }

    // Payer email generic fallback (only reached if PAYER_FILL_MAP didn't match)
    if (/email/i.test(label || '')) {
      try {
        const payerEmailDna = page.locator('input[id$="cbxDNAPAYER_EMAIL_ADDR_NA"]').first()
        if (await payerEmailDna.count() > 0 && await payerEmailDna.isChecked().catch(() => false)) {
          await payerEmailDna.click()
          await page.waitForTimeout(500)
          log('Unchecked "Does Not Apply" on payer email — field enabled')
        }
      } catch { /* not on this page */ }
    }

    const el = await findElement(page, { label, ref })
    await el.scrollIntoViewIfNeeded().catch(() => {})
    // If the resolved element is a <select>, delegate to selectOption instead of fill
    const elTag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => 'input')
    if (elTag === 'select') {
      const fast = { timeout: 1500 }
      try { await el.selectOption({ label: value }, fast); return } catch {}
      try { await el.selectOption({ value }, fast); return } catch {}
      const picked = await el.evaluate((select, requested) => {
        const normalized = String(requested).trim().toLowerCase()
        const option = Array.from(select.options).find((candidate) => {
          const text = candidate.text.trim().toLowerCase()
          return text === normalized ||
            candidate.value.trim().toLowerCase() === normalized ||
            text.startsWith(`${normalized} `)
        })
        if (!option) return false
        select.value = option.value
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }, value).catch(() => false)
      if (picked) return
      throw new Error(`Could not selectOption on <select> — label="${label}" value="${value}"`)
    }
    await suppressBrowserAutofill(el)
    await el.click()
    try {
      await el.fill(value)
    } catch {
      // Fallback for RTL / non-ASCII text: clear then type character by character
      await el.selectText().catch(() => {})
      await el.press('Control+a')
      await el.press('Delete')
      await page.keyboard.type(value, { delay: 30 })
    }
    // Verify value was accepted; if empty try keyboard.type
    const actual = await el.inputValue().catch(() => '')
    if (!actual && value) {
      await el.click()
      await page.keyboard.type(value, { delay: 30 })
    }
    await ensureUsContactNameDoNotKnowIfOrgOnly(page)
    return
  }

  if (type === 'selectOption') {
    // If GPT used selectOption for a date field, redirect to fill (triggers fillDate logic)
    if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(value) && /date|birth|dob/i.test(label || '')) {
      return executeAction(page, { type: 'fill', label, value, occurrence })
    }

    const repeatedSelect = [
      {
        match: /^social media provider\/platform$/i,
        selector: 'select[id*="dtlSocial"][id*="ddlSocialMedia"]',
      },
      {
        match: /^country visited$|^visited country\/region$/i,
        selector: 'select[id*="dtlCountriesVisited"][id*="ddlCOUNTRIES_VISITED"]',
      },
      {
        match: /^military service country$/i,
        selector: 'select[id*="dtlMILITARY_SERVICE"][id*="ddlMILITARY_SVC_CNTRY"]',
      },
      {
        match: /state of driver.?s license/i,
        selector: 'select[id*="dtlUS_DRIVER_LICENSE"][id*="ddlUS_DRIVER_LICENSE_STATE"]',
      },
    ].find((entry) => entry.match.test((label || '').trim()))
    if (repeatedSelect) {
      const selects = page.locator(repeatedSelect.selector)
      if (await selects.count() < occurrence) {
        throw new Error(`Repeated dropdown "${label}" row ${occurrence} was not found`)
      }
      const select = selects.nth(occurrence - 1)
      const picked = await select.evaluate((element, requested) => {
        const normalized = String(requested).trim().toLowerCase()
        const option = Array.from(element.options).find((candidate) => {
          const text = candidate.text.trim().toLowerCase()
          return text === normalized ||
            candidate.value.trim().toLowerCase() === normalized ||
            text.startsWith(normalized)
        })
        if (!option) return false
        element.value = option.value
        element.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }, value).catch(() => false)
      if (!picked) {
        throw new Error(`Could not select "${value}" for "${label}" row ${occurrence}`)
      }
      if (
        /^social media provider\/platform$/i.test((label || '').trim()) &&
        !/^none$/i.test(String(value || '').trim())
      ) {
        const ident = page.locator('input[id*="dtlSocial"][id*="tbxSocialMediaIdent"]').nth(occurrence - 1)
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
        await waitUntilInputEnabled(page, ident, 8000)
      }
      return
    }

    if (/^lost passport country\/authority$/i.test((label || '').trim())) {
      const selects = page.locator('select[id*="dtlLostPPT"][id*="ddlLOST_PPT_NATL"]')
      if (await selects.count() < occurrence) {
        throw new Error(`Lost-passport country row ${occurrence} was not found`)
      }
      const select = selects.nth(occurrence - 1)
      const picked = await select.evaluate((el, requested) => {
        const normalized = requested.trim().toLowerCase()
        const option = Array.from(el.options).find((candidate) =>
          candidate.text.trim().toLowerCase() === normalized ||
          candidate.value.trim().toLowerCase() === normalized
        )
        if (!option) return false
        el.value = option.value
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }, value).catch(() => false)
      if (!picked) {
        throw new Error(`Could not select lost-passport country "${value}" in row ${occurrence}`)
      }
      return
    }

    // Unit dropdown paired with a repeated previous-visit length-of-stay row.
    if (/previous.*(?:visit|u\.?s).*length.*stay|(?:visit|u\.?s).*stay.*length/i.test(label || '')) {
      const selects = page.locator(
        'select[id*="PREV_US_VISIT_LOS_CD"], select[id*="PREV_US_VISIT"][id*="LOS"][id*="CD"]',
      )
      if (await selects.count() < occurrence) {
        throw new Error(`Previous visit stay-unit row ${occurrence} was not found`)
      }
      const select = selects.nth(occurrence - 1)
      // DS-160 stores stay units as codes, not their visible labels:
      // Y=years, M=months, W=weeks, D=days, H=less than 24 hours.
      const normalizedUnit = String(value).trim().toLowerCase()
      const unitCode = normalizedUnit.includes('year') ? 'Y'
        : normalizedUnit.includes('month') ? 'M'
          : normalizedUnit.includes('week') ? 'W'
            : normalizedUnit.includes('day') && !normalizedUnit.includes('24') ? 'D'
              : normalizedUnit.includes('hour') || normalizedUnit.includes('24') ? 'H'
                : ''
      if (unitCode) {
        const matchingOption = select.locator(`option[value="${unitCode}"]`)
        if (await matchingOption.count() > 0) {
          await select.selectOption({ value: unitCode })
          return
        }
      }
      const fast = { timeout: 1500 }
      try { await select.selectOption({ label: value }, fast); return } catch {}
      try { await select.selectOption({ value }, fast); return } catch {}
      throw new Error(`Could not select previous visit stay unit "${value}" in row ${occurrence}`)
    }

    // Payer relationship dropdown — direct path using confirmed ID
    if (/relationship.*to you|relationship.*payer|payer.*relation/i.test(label || '')) {
      const relSel = page.locator('select[id$="ddlPayerRelationship"]').first()
      try {
        await relSel.waitFor({ state: 'visible', timeout: 6000 })
        // option values: C=CHILD P=PARENT S=SPOUSE R=OTHER RELATIVE F=FRIEND O=OTHER
        const picked = await relSel.evaluate((sel, v) => {
          const lo = v.toLowerCase()
          const opt = Array.from(sel.options).find(o =>
            o.text.trim().toLowerCase() === lo || o.value.toLowerCase() === lo
          )
          if (!opt) return false
          sel.value = opt.value
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }, value)
        if (picked) { log(`✅ Payer relationship selected directly: "${value}"`); return }
        // Fallback: try Playwright selectOption
        await relSel.selectOption({ label: value }, { timeout: 1500 }).catch(() => {})
        await relSel.selectOption({ value }, { timeout: 1500 }).catch(() => {})
        log(`✅ Payer relationship selected: "${value}"`)
        return
      } catch { /* fall through to generic path */ }
    }

    // "Specify" sub-purpose dropdown (B1/B2 etc.) is loaded via AJAX on the live site.
    // On a static snapshot it doesn't exist — try quickly and skip rather than wasting 20+ seconds.
    if (/^specify$/i.test((label || '').trim())) {
      const specSels = [
        'select[id*="ddlOtherPurpose"]',
        'select[id*="dlPrincipalAppTravel"][id*="Other"]',
        'select[id*="dlPrincipalAppTravel"][id*="Specify"]',
      ]
      for (const s of specSels) {
        try {
          const el = page.locator(s).first()
          await el.waitFor({ state: 'attached', timeout: 1000 })
          const fast = { timeout: 1500 }
          try { await el.selectOption({ label: value }, fast); return } catch {}
          try { await el.selectOption({ value }, fast); return } catch {}
        } catch { /* not present yet */ }
      }
      // Not found (AJAX not triggered on static page) — skip silently
      log(`⚠️  "Specify" dropdown not yet present — skipping (AJAX-dependent)`)
      return
    }

    // For LOS unit: if the value looks like a unit (Year/Month/Week/Day/Hour),
    // target the unit dropdown directly regardless of label.
    if (/year|month|week|day|hour|24 hour/i.test(value) && /stay|los/i.test(label || '')) {
      const unitSel = page.locator('select[id$="ddlTRAVEL_LOS_CD"]').first()
      if (await unitSel.isVisible({ timeout: 2000 }).catch(() => false)) {
        try { await unitSel.selectOption({ label: value }); return } catch {}
        try { await unitSel.selectOption({ value: value[0].toUpperCase() }); return } catch {}
      }
    }

    /**
     * Case-insensitive option select.  DS-160 stores country/nationality option
     * texts in ALL CAPS ("ISRAEL") but the agent may output mixed case ("Israel").
     * Playwright's built-in selectOption does exact-case matching, so we fall back
     * to a JS scan when the exact attempts fail.
     */
    async function selectOptionCI(elHandle, val) {
      // Try JS case-insensitive + prefix scan first — instant, no timeout risk.
      // Handles: "Israel" → "ISRAEL", "OTHER" → "OTHER/I DON'T KNOW", "Child" → "CHILD"
      const picked = await elHandle.evaluate((sel, v) => {
        const lo = v.toLowerCase()
        const opt = Array.from(sel.options).find(o => {
          const text = o.text.trim().toLowerCase()
          return text === lo || text.startsWith(lo + '/') || text.startsWith(lo + ' ')
        })
        if (!opt) return false
        sel.value = opt.value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }, val).catch(() => false)
      if (picked) return true

      // Fall back to Playwright selectOption (handles edge cases / dynamic options)
      const fast = { timeout: 1500 }
      try { await elHandle.selectOption({ label: val }, fast); return true } catch {}
      try { await elHandle.selectOption({ value: val }, fast); return true } catch {}
      return false
    }

    // First try as a <select> element
    try {
      const el = await findElement(page, { label, ref })
      const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => 'select')
      if (tag === 'select') {
        if (await selectOptionCI(el, value)) return
      }
      // Found an input instead of a select — scan nearby selects in the same row
      const row = el.locator('xpath=ancestor::tr[1]')
      const nearSelect = row.locator('select').first()
      if (await nearSelect.count() > 0) {
        if (await selectOptionCI(nearSelect, value)) return
      }
    } catch { /* fall through to radio */ }
    // Fallback: treat as radio (e.g. agent used selectOption for a Yes/No field)
    await clickRadioForQuestion(page, label, value)
    return
  }

  if (type === 'radio') {
    if (/did anyone assist you/i.test(label || '')) {
      const answerIndex = /^no$/i.test(String(value).trim()) ? 1 : 0
      const preparerRadio = page.locator(
        `#ctl00_SiteContentPlaceHolder_FormView3_rblPREP_IND_${answerIndex}`,
      ).first()
      await preparerRadio.waitFor({ state: 'visible', timeout: 5000 })
      if (!await preparerRadio.isChecked()) await preparerRadio.click()
      if (answerIndex === 0) {
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
        await page.waitForTimeout(400)
      }
      return
    }

    // Guard: never let the planner/vision set either prev_travel gating radio to "No"
    // when the source says Yes, or when Yes is already checked on the page.
    if (/^no$/i.test(String(value).trim())) {
      const refId = String(ref || '')
      const PREV_TRAVEL_YES_IDS = [
        {
          pattern: /have you ever been in the united states|ever been in the u\.?s\.?/i,
          refPattern: /rblPREV_US_TRAVEL_IND(?:$|_)/i,
          yesId: 'rblPREV_US_TRAVEL_IND_0',
          sourceYes: () => prevTravelRequiredYes.beenInUs,
        },
        {
          pattern: /have you ever been issued a u\.?s\.? visa/i,
          refPattern: /rblPREV_VISA_IND(?:$|_)/i,
          yesId: 'rblPREV_VISA_IND_0',
          sourceYes: () => prevTravelRequiredYes.issuedVisa,
        },
      ]
      for (const { pattern, refPattern, yesId, sourceYes } of PREV_TRAVEL_YES_IDS) {
        const matchesLabel = pattern.test(label || '')
        const matchesRef = refPattern.test(refId) && !/SAME_TYPE|SAME_CNTRY|TEN_PRINT|LOST|CANCELLED|REFUSED/i.test(refId)
        if (!matchesLabel && !matchesRef) continue
        if (sourceYes()) {
          logWarn(`[guard] Blocked planner/vision from answering "${label || refId}" No — source says Yes`)
          return
        }
        const yesRadio = page.locator(`input[id$="${yesId}"]`).first()
        if (await yesRadio.count() > 0 && await yesRadio.isChecked().catch(() => false)) {
          logWarn(`[guard] Blocked planner/vision from flipping "${label || refId}" from Yes → No`)
          return
        }
      }
    }

    if (await clickRadioByRef(page, ref, value)) return

    await clickRadioForQuestion(page, label, value)
    if (/specific travel plans/i.test(label || '') && /^no$/i.test(String(value || '').trim())) {
      await page.locator('input[id$="tbxTRAVEL_LOS"]').first()
        .waitFor({ state: 'visible', timeout: 8000 })
        .catch(() => {})
    }
    return
  }

  if (type === 'uploadPhoto') {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.waitFor({ state: 'attached', timeout: 10_000 })
    const photo = createBlankTestPhoto()
    if (photo.length > 240 * 1024) {
      throw new Error(`Generated test photo exceeds 240 KB (${photo.length} bytes)`)
    }
    await fileInput.setInputFiles({
      name: 'blank-test-photo.jpg',
      mimeType: 'image/jpeg',
      buffer: photo,
    })
    log(`Attached 600×600 blank test JPEG (${photo.length} bytes); biometric validation is expected to reject it`)
    return
  }

  if (type === 'reviewNext') {
    const url = page.url().toLowerCase()
    if (url.includes('sign') && url.includes('submit')) {
      throw new Error('⛔ BLOCKED: Review navigation reached Sign and Submit.')
    }
    const nextButton = page.locator(
      'input.next:not([disabled]), button.next:not([disabled]), ' +
      'input[id$="UpdateButton3"]:not([disabled])',
    ).first()
    await nextButton.waitFor({ state: 'visible', timeout: 5000 })
    await nextButton.scrollIntoViewIfNeeded().catch(() => {})
    await nextButton.click()
    log('Advanced to the next review section')
    return
  }

  if (type === 'submitApplication') {
    const prerequisites = await readSignSubmitPrerequisites(page)
    const missing = missingSignSubmitFields(prerequisites)
    if (missing.length) {
      throw new Error(
        `Cannot sign and submit: still missing ${missing.join(', ')}.`,
      )
    }

    const signButton = page.locator('#ctl00_SiteContentPlaceHolder_btnSignApp').first()
    await signButton.waitFor({ state: 'visible', timeout: 5000 })
    await signButton.click()
    log('Signed and submitted the DS-160 application')

    const confirmationButton = page.locator(
      '#ctl00_SiteContentPlaceHolder_UpdateButton3:not([disabled])',
    ).first()
    await confirmationButton.waitFor({ state: 'visible', timeout: 15_000 })
    await confirmationButton.scrollIntoViewIfNeeded().catch(() => {})
    await confirmationButton.click()
    log('Advanced to the DS-160 confirmation page')
    return
  }

  if (type === 'check') {
    const checkLabel = label || text || ''
    const fieldHint = action.fieldLabel || action.for || checkLabel

    // Never mark the U.S. contact email as N/A after an email has been filled.
    if (/point.*contact.*email|u\.?s\.?.*contact.*email/i.test(fieldHint)) {
      const contactEmail = page.locator('input[id$="tbxUS_POC_EMAIL_ADDR"]').first()
      const currentEmail = await contactEmail.inputValue({ timeout: 500 }).catch(() => '')
      if (currentEmail.trim()) {
        log('Skipped contact email "Does Not Apply" — email field has a value')
        return
      }
    }

    if (/^no expiration$/i.test(checkLabel.trim())) {
      const checkbox = page.locator('input[id$="cbxPPT_EXPIRE_NA"]').first()
      await checkbox.waitFor({ state: 'attached', timeout: 3000 })
      if (!await checkbox.isChecked()) await checkbox.click()
      return
    }

    if (/do not know/i.test(checkLabel) && /lost passport/i.test(action.fieldLabel || action.for || '')) {
      const checkboxes = page.locator('input[id*="dtlLostPPT"][id*="cbxLOST_PPT_NUM_UNKN_IND"]')
      if (await checkboxes.count() < occurrence) {
        throw new Error(`Lost-passport "Do Not Know" checkbox row ${occurrence} was not found`)
      }
      const checkbox = checkboxes.nth(occurrence - 1)
      if (!await checkbox.isChecked()) await checkbox.click()
      return
    }

    if (/do not know/i.test(checkLabel) && /driver.?s license/i.test(action.fieldLabel || action.for || '')) {
      const checkboxes = page.locator(
        'input[id*="dtlUS_DRIVER_LICENSE"][id*="cbxUS_DRIVER_LICENSE_NA"]',
      )
      if (await checkboxes.count() < occurrence) {
        throw new Error(`Driver's-license "Do Not Know" checkbox row ${occurrence} was not found`)
      }
      const checkbox = checkboxes.nth(occurrence - 1)
      if (!await checkbox.isChecked()) await checkbox.click()
      return
    }

    // Guard: block "Does Not Apply / Technology Not Available" ONLY when it targets
    // the native-alphabet field — check only that specific input, not the whole page.
    // (Checking all inputs was blocking State/Province when Hebrew was present elsewhere.)
    if (/does not apply|technology not available/i.test(checkLabel)) {
      try {
        const nativeEl = page.locator('input[id$="tbxAPP_FULL_NAME_NATIVE"]').first()
        const nativeVal = await nativeEl.inputValue({ timeout: 500 }).catch(() => '')
        if (nativeVal && /[^\x00-\x7F]/.test(nativeVal)) {
          // Only block if the action is actually targeting the native-alphabet row
          const fieldHintRaw = action.fieldLabel || action.for || ''
          if (!fieldHintRaw || /native|alphabet|FULL_NAME_NATIVE/i.test(fieldHintRaw)) {
            log(`⚠️  Blocked "Does Not Apply" — native-alphabet input has value: "${nativeVal.slice(0, 30)}"`)
            return
          }
        }
      } catch { /* native field not present on this page, continue */ }
    }

    // Guard: block "Do Not Know" for spouse city when the city input already has a value.
    // The planner can incorrectly output check("Do Not Know") for this field instead of fill.
    if (/do not know/i.test(checkLabel) && /city/i.test(fieldHint || checkLabel)) {
      try {
        const cityInput = page.locator('input[id$="tbxSpousePOBCity"]').first()
        if (await cityInput.count() > 0) {
          const currentCity = await cityInput.inputValue({ timeout: 500 }).catch(() => '')
          if (currentCity.trim()) {
            log(`Blocked "Do Not Know" for spouse city — input already has value: "${currentCity}"`)
            return
          }
        }
      } catch { /* not a spouse page */ }
    }

    // The matcher resolves the exact gating checkbox from the page inventory, so
    // an explicit ref is more reliable than any label heuristic below.
    if (ref) {
      try {
        const el = await findElement(page, { ref })
        await el.scrollIntoViewIfNeeded().catch(() => {})
        if (!await el.isChecked()) await el.click()
        log(`Checked "${checkLabel}" via ref=${ref}`)
        return
      } catch { /* ref did not resolve — fall back to label heuristics */ }
    }

    // Try known field-specific "Does Not Apply" first (e.g. State/Province)
    if (fieldHint) {
      const handled = await checkDoesNotApplyFor(page, fieldHint, occurrence)
      if (handled) return
    }

    // Generic: find checkbox by label text
    try {
      const el = await findElement(page, { label: checkLabel })
      await el.check()
      return
    } catch { /* fall through */ }

    // Last fallback: scan all checkboxes for nearby matching text
    const checkboxes = await page.locator('input[type="checkbox"]').all()
    for (const cb of checkboxes) {
      try {
        const parentText = await cb.locator('xpath=..').textContent()
        if (parentText && parentText.toLowerCase().includes(checkLabel.toLowerCase())) {
          await cb.check()
          return
        }
      } catch { /* skip */ }
    }
    throw missingUiTarget(`Checkbox not found for label="${checkLabel}"`)
  }

  if (type === 'selectEmbassy') {
    await selectEmbassyOnPage(page, value || 'Tel Aviv')
    return
  }

  if (type === 'click') {
    await page.evaluate(() => {
      try { window.needToConfirm = false } catch { /* ignore */ }
    }).catch(() => {})
    // Guard: block clicking "Does Not Apply" / "Technology Not Available" if
    // Block clicking "Does Not Apply" / "Technology Not Available" only when
    // the native-alphabet input has a value (same scoped guard as the check handler).
    const clickTarget = (text || label || '').toLowerCase()

    if (/start an application/i.test((text || label || '').trim())) {
      const clicked = await clickStartApplication(page)
      if (!clicked) throw new Error('Click target not found — text="START AN APPLICATION"')
      return
    }

    if (/^upload (?:your )?photo$/i.test((text || label || '').trim())) {
      const uploadButton = page.locator('input[id$="btnUploadPhoto"]').first()
      await uploadButton.waitFor({ state: 'visible', timeout: 5000 })
      await uploadButton.scrollIntoViewIfNeeded().catch(() => {})
      await uploadButton.click()
      log('Clicked "Upload Your Photo"')
      return
    }

    if (/continue without (?:a )?photo/i.test((text || label || '').trim())) {
      const continueWithoutPhoto = page.locator('input[type="image"][id$="btnNoImage"]').first()
      await continueWithoutPhoto.waitFor({ state: 'visible', timeout: 5000 })
      await continueWithoutPhoto.scrollIntoViewIfNeeded().catch(() => {})
      await continueWithoutPhoto.click()
      log('Clicked "Continue Without a Photo" after photo validation failure')
      return
    }

    if (/^(?:go to )?review$/i.test((text || label || '').trim())) {
      // The completion modal uses btnReviewPage; the Confirm Photo page also
      // exposes the REVIEW navigation tab. Prefer the modal button when shown.
      const modalReview = page.locator('input[id$="btnReviewPage"]').first()
      if (await modalReview.isVisible({ timeout: 500 }).catch(() => false)) {
        await modalReview.click()
        log('Clicked Review in the completion modal')
        return
      }
      const reviewTab = page.locator('a#REVIEW, a[id="REVIEW"]').first()
      await reviewTab.waitFor({ state: 'visible', timeout: 5000 })
      await reviewTab.scrollIntoViewIfNeeded().catch(() => {})
      await reviewTab.click()
      log('Clicked REVIEW from Confirm Photo')
      return
    }

    if (/does not apply|technology not available/i.test(clickTarget)) {
      try {
        const nativeEl = page.locator('input[id$="tbxAPP_FULL_NAME_NATIVE"]').first()
        const nativeVal = await nativeEl.inputValue({ timeout: 500 }).catch(() => '')
        if (nativeVal) {
          log(`⚠️  Blocked click on "Does Not Apply" — native alphabet field has value: "${nativeVal.slice(0, 30)}"`)
          return
        }
      } catch { /* field not present, continue */ }
    }

    // Synthetic action name used to distinguish the phone-row Add Another link
    // from the other identically labelled links on this page.
    if (/^add another phone$/i.test((text || label || '').trim())) {
      const phoneInputs = page.locator('input[id*="dtlAddPhone"][id*="tbxAddPhoneInfo"]')
      const previousRowCount = await phoneInputs.count()
      const addLinks = page.locator('a[id*="InsertButtonADDL_PHONE"]')
      const addLinkCount = await addLinks.count()
      if (addLinkCount === 0) {
        throw new Error('Additional phone "Add Another" link was not found')
      }
      const addLink = addLinks.nth(addLinkCount - 1)
      await clickAspNetPostBackLink(addLink)
      await phoneInputs.nth(previousRowCount).waitFor({ state: 'attached', timeout: 10_000 })
      log(`✅ Added phone-number row ${previousRowCount + 1}`)
      return
    }

    const repeatedAdd = [
      {
        label: 'travel companion',
        match: /^add another travel companion$/i,
        rowSelector: 'input[id*="TravelCompan" i][id*="Surname" i]',
        linkSelector: 'a[id*="TravelCompan" i][id*="InsertButton" i], a[title="Add Another"]',
      },
      {
        label: 'language',
        match: /^add another language$/i,
        rowSelector: 'input[id*="dtlLANGUAGES"][id*="tbxLANGUAGE_NAME"]',
        linkSelector: 'a[id*="dtlLANGUAGES"][id*="InsertButtonLANGUAGE"]',
      },
      {
        label: 'visited country',
        match: /^add another visited country$/i,
        rowSelector: 'select[id*="dtlCountriesVisited"][id*="ddlCOUNTRIES_VISITED"]',
        linkSelector: 'a[id*="dtlCountriesVisited"][id*="InsertButtonCountriesVisited"]',
      },
      {
        label: 'organization',
        match: /^add another organization$/i,
        rowSelector: 'input[id*="dtlORGANIZATIONS"][id*="tbxORGANIZATION_NAME"]',
        linkSelector: 'a[id*="dtlORGANIZATIONS"][id*="InsertButtonORGANIZATION"]',
      },
      {
        label: 'military service',
        match: /^add another military service$/i,
        rowSelector: 'select[id*="dtlMILITARY_SERVICE"][id*="ddlMILITARY_SVC_CNTRY"]',
        linkSelector: 'a[id*="dtlMILITARY_SERVICE"][id*="InsertButtonMILITARY_SERVICE"]',
      },
      {
        label: 'email address',
        match: /^add another email$/i,
        rowSelector: 'input[id*="dtlAddEmail"][id*="tbxAddEmailInfo"]',
        linkSelector: 'a[id*="InsertButtonADDL_EMAIL"]',
      },
      {
        label: 'social-media account',
        match: /^add another social media$/i,
        rowSelector: 'select[id*="dtlSocial"][id*="ddlSocialMedia"]',
        linkSelector: 'a[id*="InsertButtonSOCIAL_MEDIA_INFO"]',
      },
      {
        label: "driver's-license",
        match: /^add another driver.?s license$/i,
        rowSelector: 'input[id*="dtlUS_DRIVER_LICENSE"][id*="tbxUS_DRIVER_LICENSE"]',
        linkSelector: 'a[id*="InsertButtonUS_DRIVER_LICENSE"]',
      },
    ].find((entry) => entry.match.test((text || label || '').trim()))
    if (repeatedAdd) {
      const rows = page.locator(repeatedAdd.rowSelector)
      const previousRowCount = await rows.count()
      const links = page.locator(repeatedAdd.linkSelector)
      const linkCount = await links.count()
      if (!linkCount) throw new Error(`Add Another link for ${repeatedAdd.label} was not found`)
      const link = links.nth(linkCount - 1)
      await clickAspNetPostBackLink(link)
      await rows.nth(previousRowCount).waitFor({ state: 'attached', timeout: 10_000 })
      log(`✅ Added ${repeatedAdd.label} row ${previousRowCount + 1}`)
      return
    }

    // Previous U.S. visits are repeatable. Invoke the link's ASP.NET postback
    // target directly so ValidNavigation()/the javascript: href cannot block it.
    if (/^add another$/i.test((text || label || '').trim())) {
      const stayInputs = page.locator(
        'input[type="text"][id*="tbxPREV_US_VISIT_LOS"], input[type="number"][id*="PREV_US_VISIT"][id*="LOS"]',
      )
      const previousRowCount = await stayInputs.count()
      const addLinks = page.locator(
        'a[id*="InsertButtonPREV_US_VISIT"], a[title="Add Another"][href*="PREV_US_VISIT"]',
      )
      const addLinkCount = await addLinks.count()
      if (addLinkCount === 0) {
        throw new Error('Previous visit "Add Another" link was not found')
      }
      const addLink = addLinks.nth(addLinkCount - 1)
      await clickAspNetPostBackLink(addLink)
      const created = await stayInputs.nth(previousRowCount).waitFor({
        state: 'attached',
        timeout: 10_000,
      }).then(() => true).catch(() => false)
      if (!created) {
        throw new Error(
          `Previous visit "Add Another" did not create row ${previousRowCount + 1} ` +
          `(CEAC allows at most ${MAX_PREV_US_VISITS})`,
        )
      }
      log(`✅ Added previous U.S. visit row ${previousRowCount + 1}`)
      return
    }

    if (/^next/i.test((text || label || '').trim())) {
      await prepareAddressPhoneForNavigation(page)
    }

    if (/^(next|continue)\b/i.test((text || label || '').trim())) {
      const official = page.locator(
        'input.next[id$="UpdateButton3"], input[id$="UpdateButton3"], input[type="submit"].next, input[id$="btnContinue"]',
      ).first()
      if (await official.isVisible({ timeout: 1500 }).catch(() => false)) {
        await official.scrollIntoViewIfNeeded().catch(() => {})
        await official.click()
        return
      }
    }

    // For "Next" / "Continue" navigation clicks, fall back to finding any
    // visible DS-160 submit button whose value starts with "Next" or "Continue".
    try {
      const el = await findElement(page, { text, label })
      await el.click()
      return
    } catch {
      if (/^next|^continue/i.test((text || label || ''))) {
        const submitBtns = await page.locator('input[type="submit"], button[type="submit"]').all()
        for (const btn of submitBtns) {
          try {
            const btnText = (await btn.getAttribute('value') || await btn.textContent() || '').trim()
            if (/^next|^continue/i.test(btnText) && await btn.isVisible()) {
              await btn.scrollIntoViewIfNeeded().catch(() => {})
              await btn.click()
              log(`✅ Navigation click via submit-button fallback: "${btnText}"`)
              return
            }
          } catch { /* try next */ }
        }
      }
      throw new Error(`Click target not found — text="${text}" label="${label}"`)
    }
  }

  if (type === 'wait') {
    // Use networkidle so ASP.NET UpdatePanel AJAX (triggered by dropdowns/radios) fully
    // completes before the next action.  Hard-cap at 6s to avoid hanging on slow servers.
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(800)
    return
  }
}

export function actionCanBeDeferredForTesting(action) {
  const actionTarget = String(action?.text || action?.label || action?.fieldLabel || '')
  // Repeat-row actions represent source records and are never optional. A
  // failed Add Another must stop the run rather than silently omit a person,
  // visit, employer, school, or other supplied record.
  if (/^add another\b/i.test(actionTarget)) return false
  return /optional/i.test(actionTarget) || action?.optional === true
}

// ─── Section detector ────────────────────────────────────────────────────────

let _lastSection = ''

/**
 * Read the current DS-160 section heading from the page and log if changed.
 */
export async function detectAndLogSection(page) {
  try {
    // DS-160 uses a left nav and a page heading in various places
    const headingSelectors = [
      'h2.Section',
      '.Section-header',
      '#ctl00_SiteContentPlaceHolder_FormView1_hd',
      'h2',
      'h3',
      '.step-title',
      'legend',
    ]

    for (const sel of headingSelectors) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'visible', timeout: 500 })
        const heading = (await el.textContent())?.trim()
        if (heading && heading !== _lastSection) {
          _lastSection = heading
          logSection(heading)
          return heading
        }
      } catch { /* try next */ }
    }

    // Fallback: page title
    const title = await page.title()
    if (title && title !== _lastSection) {
      _lastSection = title
      logSection(title)
      return title
    }
  } catch { /* ignore */ }
  return _lastSection
}

// ─── System prompt components ─────────────────────────────────────────────────

/**
 * Core rules sent on every planner and vision call.
 * Prefix-cacheable because it never changes at runtime.
 */
export const AGENT_CORE_RULES = `You are a browser automation agent filling a U.S. DS-160 nonimmigrant visa application form on behalf of an applicant.

ACTION SCHEMA — use exactly these action types:
{"type":"fill","label":"<exact visible label text>","value":"<text to type>"}
{"type":"selectOption","label":"<exact visible label text>","value":"<option text>"}
{"type":"radio","label":"<question label text>","value":"Yes OR No"}
{"type":"fill","label":"<repeated field label>","value":"<text>","occurrence":<1-based row number>}
{"type":"selectOption","label":"<repeated field label>","value":"<option>","occurrence":<1-based row number>}
{"type":"check","label":"<exact visible checkbox or label text>"}
{"type":"click","text":"<exact visible button or link text>"}
{"type":"uploadPhoto"}
{"type":"reviewNext"}
{"type":"solveCaptcha"}
{"type":"submitApplication"}
{"type":"wait"}
{"type":"defer","reason":"<why this optional/non-blocking item is being deferred>","fieldLabel":"<field or action>"}
{"type":"done"}

GENERAL RULES:
- Testing continuity: If an optional field or an extra repeatable-row action cannot be completed after it has already failed, you may output {"type":"defer",...}. Never defer a required field, an unanswered Yes/No question, or any field named in VISIBLE VALIDATION ERRORS.
- Use the EXACT visible text of the label as it appears on screen. Only act on fields actually visible in the UI.
- CRITICAL: Yes/No questions on the DS-160 are RADIO BUTTONS. Always use {"type":"radio"} for Yes/No questions, NEVER {"type":"fill"} or {"type":"selectOption"}.
- Do NOT skip any Yes/No question — answer every one before clicking Next.
- If VISIBLE VALIDATION ERRORS are provided, treat them as the highest priority. Identify the referenced field and output the corrective action before continuing.
- A validation summary can remain visible after its field is corrected. If ACTIONS ALREADY TAKEN shows that the latest post-navigation action already corrected the referenced field, retry the same Next/Save navigation action instead of repeating the correction.
- Use {"type":"selectOption"} for actual <select> dropdown menus. Key dropdown fields: Sex (use "MALE" or "FEMALE"), Marital Status (use "SINGLE", "MARRIED", "WIDOWED", "DIVORCED", "SEPARATED"), Country, State.
- NEVER use {"type":"fill"} for Sex or Marital Status — these are <select> dropdowns.
- For "Does Not Apply" checkboxes: {"type":"check","label":"Does Not Apply"}.
- After selecting a dropdown or clicking a radio button that triggers dependent fields, output {"type":"wait"} once as your NEXT action. After that wait, continue to the next unanswered field. Never reselect a radio whose desired answer is already selected.
- For the security question setup: select "WHAT WAS YOUR HOME PHONE NUMBER WHEN YOU WERE A CHILD?" and enter answer "049824393".
- If you see a CAPTCHA image on the page: output {"type":"solveCaptcha"}.
- If you see Cloudflare "Just a moment", "Performing security verification", or a "Verify you are human" checkbox: output {"type":"wait"}. Do not output solveCaptcha and do not try to click the widget — a human must complete it.
- If a field has N/A in the applicant data: check "Does Not Apply" if the checkbox is present, otherwise skip.
- Phone number fields must be filled with digits only. Strip +, spaces, hyphens, and parentheses: "+972 538055645" → "972538055645".
- CRITICAL: For "Full Name in Native Alphabet" — if the applicant data contains a native-alphabet name (Hebrew, Arabic, or any non-Latin script), you MUST fill it using {"type":"fill"} and you MUST NEVER output {"type":"check"} or {"type":"click"} targeting "Does Not Apply" or "Technology Not Available" for this field. Only check "Does Not Apply" if the applicant data explicitly has N/A or is completely absent for the native name.
- If a field has ❗ MISSING: skip it (leave blank), then continue. Never output {"type":"done"} because a value is missing.
- Click "Next" or "Continue" only after ALL visible fields on the current section are filled. Use the EXACT visible button text (e.g. "Next: Personal 2") — never shorten it to just "Next".
- Never output {"type":"done"} to stop the application. The run is only complete after Sign and Submit and the confirmation PDFs are saved. If this page has no more fields you can fill, click Next/Continue.
- On the Sign and Submit page, complete fields in this exact order: (1) answer "Yes" to "Did anyone assist you in filling out this application?" and fill the JVisa preparer (organization JVISA, 27 Hermon Street, Nahariya 2220527, Israel, relationship Clerk; preparer personal names Does Not Apply), (2) fill "Enter your Passport/Travel Document Number" from the applicant's passport data, (3) output {"type":"solveCaptcha"}. After CAPTCHA is solved, the code verifies the preparer, passport, and CAPTCHA and clicks "Sign and Submit Application".
- Never use a generic click action for "Sign and Submit Application"; only the guarded submitApplication action may click it.
- If you are on a preview/review screen (no editable fields visible), output {"type":"reviewNext"} to advance to the next review section. Repeat on every review page until Sign and Submit is reached.
- Fill fields in top-to-bottom, left-to-right order as they appear on screen.
- DS-160 exact label names: city of birth is labeled "City"; state/province of birth is labeled "State/Province" — if the applicant data has N/A or no value for that field, output {"type":"check","label":"Does Not Apply","fieldLabel":"State/Province"} to check its "Does Not Apply" checkbox; only use {"type":"fill","label":"State/Province"} when there is an actual value; country of birth is labeled "Country/Region of Birth" and is a <select> dropdown — always use {"type":"selectOption"} for it.
- For Date of Birth always use {"type":"fill","label":"Date of Birth","value":"DD/MM/YYYY"} — the code handles splitting into the Day/Month/Year dropdowns automatically. Never use selectOption for date fields.`

/**
 * Page-specific rules indexed by pageContext.
 * Each value is appended to AGENT_CORE_RULES when calling the planner for that page.
 */
export const PAGE_RULES = {
  personal2: `
Personal Information 2 rules:
  * "Are you a permanent resident of a country/region other than your country/region of origin?" is a radio button — use {"type":"radio"} with Yes or No
  * National Identification Number — always fill with the value (Israeli ID number); NEVER check "Does Not Apply" for this field
  * U.S. Social Security Number — if the applicant has a value, fill it; if absent/N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Social Security Number"}
  * U.S. Taxpayer ID Number — if the applicant has a value, fill it; if absent/N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Taxpayer ID"}`,

  travel: `
Travel Information rules:
  * "Purpose of Trip to the U.S." is a <select> dropdown — use {"type":"selectOption","label":"Purpose of Trip to the U.S.","value":"TEMP. BUSINESS OR PLEASURE VISITOR (B)"} (or whichever class matches). After selecting, output {"type":"wait"} — a second "Specify" dropdown will appear
  * "Specify" dropdown — use {"type":"selectOption","label":"Specify","value":"BUSINESS OR TOURISM (TEMPORARY VISITOR) (B1/B2)"} (or the most specific match). After selecting, output {"type":"wait"}
  * "Have you made specific travel plans?" is a radio button — use {"type":"radio"} with Yes or No. After answering, output {"type":"wait"}
  * If YES to specific travel plans: fill arrival city, arrival date fields. State field for destination is a <select> dropdown — use {"type":"selectOption"}
  * If NO to specific travel plans: for "Intended Date of Arrival" output {"type":"fill","label":"Intended Date of Arrival","value":"DD/MM/YYYY"} — the code automatically fills the Day dropdown (options 1–31), the Month dropdown (3-letter: JAN/FEB…DEC), and the Year text input; for "Intended Length of Stay in U.S." output TWO actions: first {"type":"fill","label":"Intended Length of Stay in U.S.","value":"<integer>"} for the quantity — the value MUST be a whole integer with no decimals or fractions; if the duration is fractional, convert down to the next smaller unit to get a whole number (e.g. 1.5 months → 6 weeks; 0.5 years → 6 months; 2.5 weeks → 18 days); then {"type":"selectOption","label":"Intended Length of Stay in U.S.","value":"Month(s)"} for the unit — exact unit option texts are: "Year(s)", "Month(s)", "Week(s)", "Day(s)", "Less Than 24 Hours"
  * U.S. stay address fields are separate. Street Address (Line 1) is maxlength 40 — never paste city, state, ZIP, or country into it. Use: {"type":"fill","label":"Street Address (Line 1)","value":"<street only>"}, {"type":"fill","label":"City","value":"<city>"}, {"type":"selectOption","label":"State","value":"<state>"}, {"type":"fill","label":"ZIP Code","value":"<zip>"}. If Line 1 is already packed ("street, city, ST ZIP"), split it; prefer the dedicated City value from APPLICANT DATA over a city embedded in the street line.
  * "Person/Entity Paying for Your Trip" is a <select> dropdown — use {"type":"selectOption","label":"Person/Entity Paying for Your Trip","value":"<option>"} with the exact option text: "Self", "Other Person", "Present Employer", "Employer in the U.S.", or "Other Company/Organization". After selecting, output {"type":"wait"} — if not Self, additional fields will appear
  * If "Other Person" is selected, fill the payer's sub-fields in this order:
    1. Surnames (last name) — {"type":"fill","label":"Surnames of Person Paying for Trip","value":"<last name>"}
    2. Given Names (first name) — {"type":"fill","label":"Given Names of Person Paying for Trip","value":"<first name>"}
    3. Phone Number — {"type":"fill","label":"Telephone Number of Person Paying for Trip","value":"<phone>"}
    4. Email Address — {"type":"fill","label":"Email Address of Person Paying for Trip","value":"<email>"} — the code automatically unchecks "Does Not Apply" before filling; if the payer has no email, skip this field (leave "Does Not Apply" checked)
    5. Relationship — {"type":"selectOption","label":"Relationship to You","value":"<relationship>"} — exact option values on screen: "CHILD", "PARENT", "SPOUSE", "OTHER RELATIVE", "FRIEND", "OTHER". If the relationship is not explicitly stated in the payer data, infer it from the Travel Companions section
    6. Address Same — answer the radio: {"type":"radio","label":"Is the address of the party paying for your trip the same as your Home or Mailing Address?","value":"Yes"} or "No". Answer Yes only if the payer's address is identical to the applicant's home/mailing address; otherwise answer No
    7. Street Address (only if No to step 6) — {"type":"fill","label":"Street Address of Person Paying for Trip","value":"<address>"}
    For the "Name" field in the applicant data (e.g., "OREN KOFMAN"), split it: last word(s) = Surname, first word(s) = Given Name
  * If "Other Company/Organization" is selected, the extra fields are inside the payer panel. Relationship is a free-text box, not the Other Person dropdown. Never put these values in the U.S. stay Street Address or City fields. Use these actions, in order:
    1. {"type":"fill","label":"Name of Company/Organization Paying for Trip","value":"<organization>"}
    2. {"type":"fill","label":"Telephone Number of Company Paying","value":"<digits only>"}
    3. {"type":"fill","label":"Relationship of Company Paying","value":"<role, for example Advisor to the Ministry Director General>"}
    4. {"type":"fill","label":"Payer Company Street Address (Line 1)","value":"<street only>"}
    5. When a second line exists: {"type":"fill","label":"Payer Company Street Address (Line 2)","value":"<line 2>"}
    6. {"type":"fill","label":"Payer Company City","value":"<city>"}
    7. If there is no state/province, {"type":"check","label":"Does Not Apply","fieldLabel":"Payer Company State/Province"}. Otherwise {"type":"fill","label":"Payer Company State/Province","value":"<state>"}
    8. If a postal code is present, {"type":"fill","label":"Payer Company Postal Zone/ZIP Code","value":"<code>"}. If it is missing or DOES NOT APPLY, {"type":"check","label":"Does Not Apply","fieldLabel":"Payer Company Postal Zone/ZIP Code"}
    9. {"type":"selectOption","label":"Payer Company Country/Region","value":"<country, for example ISRAEL>"}
    A single address line such as "Kanfei Nesharim 5, Jerusalem, Israel" splits into street "Kanfei Nesharim 5", city "Jerusalem", country "ISRAEL", and Does Not Apply for State/Province.`,

  companions: `
Travel Companions rules:
  * Answer "Are there other persons traveling with you?" once. If Yes, wait once for the dependent section.
  * Answer "Are you traveling as part of a group or organization?" once. For individually named companions this must be No; then wait once for the companion rows.
  * Fill each individual row in this order using the same 1-based occurrence for all three actions: "Surnames of Person Traveling With You", "Given Names of Person Traveling With You", then "Relationship with Person".
  * Relationship is a dropdown. Map Spouse → "SPOUSE", Child/Son/Daughter → "CHILD", Parent/Mother/Father → "PARENT", other family relationships → "OTHER RELATIVE", Friend → "FRIEND", otherwise → "OTHER".
  * Before companion occurrence 2 or later, output {"type":"click","text":"Add Another Travel Companion"} exactly once, then fill the newly added row. Do not click Next until every companion in APPLICANT DATA has a completed row.`,

  address: `
Address and Phone page — home address fields are separate controls. Use these exact actions and never reuse the street-address label for the ZIP value:
  * {"type":"fill","label":"Street Address (Line 1)","value":"<street address only>"}
  * {"type":"fill","label":"Street Address (Line 2)","value":"<optional second line>"} when present
  * {"type":"fill","label":"City","value":"<home city>"}
  * {"type":"fill","label":"State/Province","value":"<home state>"} or check Does Not Apply
  * {"type":"fill","label":"Postal Zone/ZIP Code","value":"<postal code only>"}
  * {"type":"selectOption","label":"Country/Region","value":"<home country>"}
  * If Postal Zone/ZIP Code is unknown or N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Postal Code"} instead of filling it
  * Answer "Is your Mailing Address the same as your Home Address?". If No, fill every displayed mailing field with these actions: {"type":"fill","label":"Mailing Street Address (Line 1)","value":"<street>"}, {"type":"fill","label":"Mailing Street Address (Line 2)","value":"<optional>"}, {"type":"fill","label":"Mailing City","value":"<city>"}, {"type":"fill","label":"Mailing State/Province","value":"<state>"}, {"type":"fill","label":"Mailing Postal Zone/ZIP Code","value":"<postal>"}, and {"type":"selectOption","label":"Mailing Country/Region","value":"<country>"}. Never use bare home-address labels for mailing values.
  * Process the PHONE section before the EMAIL ADDRESS section.
  * If Secondary Phone Number is N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Secondary Phone"}.
  * If Work Phone Number is N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Work Phone"}.
  * After answering Yes to "Have you used any other phone numbers in the last five years?", fill {"type":"fill","label":"Additional Phone Number","value":"<number>","occurrence":1}. Before each later number, output {"type":"click","text":"Add Another Phone"}, then fill occurrence 2, 3, etc.
  * In EMAIL ADDRESS, fill "Email Address" first, then answer "Have you used any other email addresses in the last five years?"
  * If other emails is Yes, fill {"type":"fill","label":"Additional Email Address","value":"<email>","occurrence":1}. Before each later email output {"type":"click","text":"Add Another Email"}, then use occurrence 2, 3, etc.
  * SOCIAL MEDIA is not a Yes/No field. If the source says No to social media in the last 5 years, lists None, or has no platform accounts, immediately select {"type":"selectOption","label":"Social Media Provider/Platform","value":"NONE","occurrence":1} and do not leave "- SELECT ONE -". For each listed account, select {"type":"selectOption","label":"Social Media Provider/Platform","value":"FACEBOOK","occurrence":1}, wait for the postback, then fill {"type":"fill","label":"Social Media Identifier","value":"<username or handle, not password>","occurrence":1}. Infer provider and handle from URLs when necessary. Before each later account output {"type":"click","text":"Add Another Social Media"}, then use occurrence 2, 3, etc.
  * Finally answer the separate radio question beginning "Do you wish to provide information about your presence on any other websites or applications...".`,

  passport: `
Passport Information page rules:
  * Passport/Travel Document Type is a dropdown: {"type":"selectOption","label":"Passport/Travel Document Type","value":"REGULAR"}
  * Passport number: {"type":"fill","label":"Passport/Travel Document Number","value":"<number>"}
  * If Passport Book Number is No/N/A, check "Does Not Apply" for that field.
  * Country/Authority that Issued Passport/Travel Document is a dropdown: {"type":"selectOption","label":"Country/Authority that Issued Passport/Travel Document","value":"<country>"}. Match the visible country option (for example Israel selects option value ISRL).
  * Place of issuance fields use synthetic labels so they route unambiguously: "Passport Issuance City", "Passport Issuance State/Province", and "Passport Issuance Country/Region".
  * Issuance Date — always use {"type":"fill","label":"Issuance Date","value":"DD/MM/YYYY"} — the code automatically fills the Day dropdown, the Month dropdown (3-letter: JAN/FEB…DEC), and the Year text input. NEVER use selectOption for date fields
  * Expiration Date — always use {"type":"fill","label":"Expiration Date","value":"DD/MM/YYYY"} — same automatic splitting applies
  * Only when the source explicitly says there is no expiration date, output {"type":"check","label":"No Expiration"}. Never use this checkbox for the lost/stolen-passport question.
  * "Have you ever lost a passport or had one stolen?" is a radio: Yes selects rblLOST_PPT_IND_0 and No selects rblLOST_PPT_IND_1.
  * If Yes, use occurrence 1 for: "Lost Passport/Travel Document Number", "Lost Passport Country/Authority", and "Lost Passport Explanation". If the number is unknown, output {"type":"check","label":"Do Not Know","fieldLabel":"Lost Passport Number","occurrence":1}.`,

  contact: `
U.S. Point of Contact page rules:
  * This page is mandatory. APPLICANT DATA must provide either a complete contact-person name or an organization name, plus relationship, street, city, state, and phone.
  * CEAC is either-or for the person vs the organization: a real Organization Name (e.g. HOTELS) with blank person names fails validation ("Surnames has not been completed"). If the organization is filled and there is no real contact person, you MUST check the Contact Person "Do Not Know" checkbox. Never leave Surnames/Given Names empty next to a filled organization, and never type "DO NOT KNOW" into those text inputs.
  * Conversely, a real contact-person name with no organization → check Organization Name "Do Not Know".
  * Use only values under the U.S. CONTACT INFORMATION section. Never reuse travel accommodation, the applicant's own phone/address, or another section's values.
  * Never copy examples, hints, or placeholders from the page. In particular, "5555555555" is a UI example and must never be used unless it explicitly appears in APPLICANT DATA.
  * If required contact data is marked ❗ MISSING, skip inventing a value. Check Do Not Know / Does Not Apply when those boxes exist, then click Next. Never output {"type":"done"}.
  * Contact Person Surname/Given Name — if the source says "DO NOT KNOW" or similar, or an organization is filled with no person, output {"type":"check","label":"Do Not Know","fieldLabel":"Contact Person Surname"}. NEVER type "DO NOT KNOW" into the surname or given-name text input.
  * Contact Person Surname/Given Name — if a real name is provided, fill surname with {"type":"fill","label":"Surnames","value":"<surname>"} and given name with {"type":"fill","label":"Given Names","value":"<given_name>"}.
  * Organization Name — if present use {"type":"fill","label":"Organization Name","value":"<organization>"}
  * If Organization Name is N/A or unknown, check the form's "Do Not Know" checkbox with {"type":"check","label":"Do Not Know","fieldLabel":"U.S. Point of Contact Organization Name"}
  * Phone Number — use {"type":"fill","label":"Phone Number","value":"<phone>"}; this maps directly to tbxUS_POC_HOME_TEL
  * Email Address — when present use {"type":"fill","label":"Email Address","value":"<email>"}; this maps directly to tbxUS_POC_EMAIL_ADDR
  * Only if the source explicitly says the contact email is N/A or absent, use {"type":"check","label":"Does Not Apply","fieldLabel":"U.S. Point of Contact Email Address"}. Never check it when an email value exists.
  * ZIP Code — this field is optional ("if known"). If the source says N/A or DOES NOT APPLY, skip it entirely (leave blank). Do NOT type "DOES NOT APPLY" into the ZIP code input.`,

  family: `
Family Information page rules:
  * The form repeats "Surnames" and "Given Names" labels for Father, Mother, and U.S. Relatives — you MUST prefix the label with the family member so the code routes it to the correct field:
    - Father section: {"type":"fill","label":"Father Surnames","value":"..."} and {"type":"fill","label":"Father Given Names","value":"..."}
    - Mother section: {"type":"fill","label":"Mother Surnames","value":"..."} and {"type":"fill","label":"Mother Given Names","value":"..."}
    - U.S. Relative section: {"type":"fill","label":"Relative Surnames","value":"..."} and {"type":"fill","label":"Relative Given Names","value":"..."}
  * For "Do Not Know" DOB checkboxes, always include a fieldLabel that names the parent: {"type":"check","label":"Do Not Know","fieldLabel":"Father Date of Birth"} or {"type":"check","label":"Do Not Know","fieldLabel":"Mother Date of Birth"}
  * Father's Date of Birth — if N/A: {"type":"check","label":"Do Not Know","fieldLabel":"Father Date of Birth"}; if known: {"type":"fill","label":"Father Date of Birth","value":"DD/MM/YYYY"}
  * Mother's Date of Birth — if N/A: {"type":"check","label":"Do Not Know","fieldLabel":"Mother Date of Birth"}; if known: {"type":"fill","label":"Mother Date of Birth","value":"DD/MM/YYYY"}
  * "Is your father in the U.S.?" and "Is your mother in the U.S.?" are radio buttons — use {"type":"radio"}
  * "Do you have any immediate relatives, not including parents, in the United States?" is a radio button
  * "Do you have any other relatives in the United States?" is a radio button
  * Father's Status and Mother's Status are <select> dropdowns — use {"type":"selectOption"}. Options are: "U.S. CITIZEN", "U.S. LEGAL PERMANENT RESIDENT (LPR)", "NONIMMIGRANT", "OTHER/I DON'T KNOW". Use "OTHER/I DON'T KNOW" when status is not known or not applicable
  * "Relationship to You" and "Relative's Status" for U.S. relatives are <select> dropdowns`,

  spouse: `
Spouse Information page rules:
  * Use values only from the 🟦 SPOUSE INFORMATION section. Never copy a name from RELATIVES IN THE U.S., U.S. CONTACT INFORMATION, or TRAVEL COMPANIONS.
  * Fill "Spouse's Surnames" from Spouse Surname and "Spouse's Given Names" from Spouse Given Name.
  * Before navigating, verify the entered spouse name exactly matches those two spouse-source fields.
  * Spouse City of Birth — fill with {"type":"fill","label":"City","value":"<city>"}. Only check "Do Not Know" if the source explicitly says N/A or unknown for this field. NEVER check Do Not Know when the source provides a real city name.`,

  work_previous: `
Previous Work / Education page:
  * Employer Name, School / Institution Name, and Job Title may only use A-Z, 0-9, hyphen, apostrophe, ampersand, and spaces. Never type a period — "Elbit Systems Ltd." must be "Elbit Systems Ltd".
  * Never type the literal value "N/A", "DOES NOT APPLY", or "DO NOT KNOW" into a previous-employer or education input when its row has a checkbox.
  * For each previous employer row, when State/Province or ZIP is N/A/DOES NOT APPLY, use {"type":"check","label":"Does Not Apply","fieldLabel":"Previous Employer State/Province","occurrence":1} or fieldLabel "Previous Employer Postal Zone/ZIP Code".
  * When a previous supervisor surname or given names are N/A/DO NOT KNOW/unknown, use {"type":"check","label":"Do Not Know","fieldLabel":"Previous Employer Supervisor Surname","occurrence":1} and fieldLabel "Previous Employer Supervisor Given Names". Never fill those marker values into the name inputs.
  * Previous employment dates must use {"type":"fill","label":"Start Date","value":"DD/MM/YYYY","occurrence":1} and {"type":"fill","label":"End Date","value":"DD/MM/YYYY","occurrence":1}. Both actions fill Day, Month, and Year.
  * Always answer "Have you attended any educational institutions at a secondary level or above?" using {"type":"radio"} before filling education rows.
  * Fill previous-employer city with {"type":"fill","label":"Employer City","value":"<city>","occurrence":1}. Never use the bare "City" label for the employer — that label is shared with education on the same page.
  * Fill each education city with {"type":"fill","label":"Education City","value":"<city>","occurrence":1}. Never use the bare "City" label for education.
  * For each education row, when State/Province or ZIP is N/A/DOES NOT APPLY, check Does Not Apply with fieldLabel "Education State/Province" or "Education Postal Zone/ZIP Code" and the matching occurrence.
  * Education dates use labels "Attendance From" and "Attendance To" with DD/MM/YYYY and the matching occurrence.`,

  work_additional: `
Additional Work / Education page:
  * Fill the first language with {"type":"fill","label":"Language Name","value":"<language>","occurrence":1}.
  * Before each later language, use exactly {"type":"click","text":"Add Another Language"}, then fill "Language Name" with occurrence 2, 3, etc.
  * Never use generic {"type":"click","text":"Add Another"} for languages; that action is reserved for previous U.S. visits.
  * Answer every Yes/No question on this page, including clan/tribe, countries visited, organizations, specialized skills, military service, and paramilitary/insurgent organizations.
  * For visited countries use "Country Visited"; before later rows use "Add Another Visited Country".
  * For organizations use "Organization Name"; before later rows use "Add Another Organization".
  * If specialized skills is Yes, fill {"type":"fill","label":"Specialized Skills Explanation","value":"<details>"}.
  * Military fields use "Military Service Country", "Branch of Service", "Rank/Position", "Military Specialty", "Service From", and "Service To". Dates use DD/MM/YYYY and every action uses the same 1-based occurrence. Before a later military record, use "Add Another Military Service".
  * If paramilitary/insurgent involvement is Yes, fill {"type":"fill","label":"Paramilitary/Insurgent Explanation","value":"<details>"}.`,

  work_present: `
Present Work / Education page:
  * Present Employer or School Name and Job Title may only use A-Z, 0-9, hyphen, apostrophe, ampersand, and spaces. Strip periods (Ltd. → Ltd).
  * Current employment Start Date must use {"type":"fill","label":"Start Date","value":"DD/MM/YYYY"}. The code fills ddlEmpDateFromDay, ddlEmpDateFromMonth, and tbxEmpDateFromYear.
  * "Briefly describe your duties:" is required. Use the source's Describe Your Duties value when available. If it is missing/N/A and Primary Occupation is STUDENT, fill "Studying". For any other occupation with this visible field and no duties data, fill "Performing the regular duties associated with my position." Never skip this visible field and never enter "N/A".`,

  security: `
Security and Background pages 1–5:
  * Every visible question is a Yes/No radio and must be answered when its corresponding source item exists.
  * The source uses short labels such as "Communicable diseases", "Arrests or convictions", "Espionage", and "Immigration fraud". You may use those exact short source labels in radio actions; the code maps them to the full legal question and confirmed radio ID.
  * Process each source security item once in screen order. Do not use generic unscoped Yes/No controls.`,

  photo: `
Photo page (development/test flow only):
  * On the DS-160 Upload Photo page, output {"type":"click","text":"Upload Your Photo"}.
  * When the external photo tool displays a file input, output {"type":"uploadPhoto"}. The code attaches a generated 600×600 JPEG under 240 KB.
  * The generated image is blank and is expected to fail biometric/face validation. Never claim that it is an approved applicant photo.
  * If photo validation fails and the UI displays "Next: Continue Without a Photo", output {"type":"click","text":"Continue Without a Photo"}. The code targets btnNoImage directly.
  * On the Confirm Photo page, output {"type":"click","text":"Review"}. The code clicks btnReviewPage when its completion modal is visible, otherwise the confirmed REVIEW navigation tab.`,

  prev_travel: `
Previous U.S. Travel page — process fields strictly in the following screen order. Every Yes/No question is a radio button; use {"type":"radio"} with the label copied EXACTLY as it appears on screen:
  * "Have you ever been in the United States?" → Yes/No
  * If Yes, fill every previous visit in source order. These are repeated fields, so always use these synthetic labels and the same 1-based occurrence for all three actions in a row:
    1. Arrival date: {"type":"fill","label":"Previous Visit Arrival Date","value":"DD/MM/YYYY","occurrence":1}
    2. Stay quantity: {"type":"fill","label":"Previous Visit Length of Stay","value":"<integer>","occurrence":1}
    3. Stay unit: {"type":"selectOption","label":"Previous Visit Length of Stay","value":"Month(s)","occurrence":1}
  * Exact stay-unit options are "Year(s)", "Month(s)", "Week(s)", "Day(s)", and "Less Than 24 Hours". Convert source units to the matching option.
  * Before visit 2 and each later visit, output exactly {"type":"click","text":"Add Another"}. The code waits for the new row. Then repeat the three actions with occurrence 2, 3, etc. Never refill occurrence 1 with a later visit's data, and never try to fill an occurrence before adding its row.
  * Next answer "Do you or did you ever hold a U.S. Driver's License?". If Yes, fill "Driver's License Number" and select "State of Driver's License" with occurrence 1. Before each later license output {"type":"click","text":"Add Another Driver's License"}, then use occurrence 2, 3, etc. If a number is unknown, check "Do Not Know" with fieldLabel "Driver's License Number" and the matching occurrence.
  * Next answer "Have you ever been issued a U.S. Visa?". If Yes, process its fields in this exact order:
    1. {"type":"fill","label":"Date Last Visa Was Issued","value":"DD/MM/YYYY"}
    2. {"type":"fill","label":"Visa Number","value":"<number>"}; if unknown, check "Do Not Know"
    3. Radio: "Are you applying for the same type of visa?"
    4. Radio: "Are you applying in the same country or location where the visa above was issued, and is this country or location your place of principal of residence?"
    5. Radio: "Have you been ten-printed?"
    6. Radio: "Has your U.S. Visa ever been lost or stolen?"; if Yes, fill "Lost Visa Year" and "Lost Visa Explanation"
    7. Radio: "Has your U.S. Visa ever been cancelled or revoked?"; if Yes, fill "Cancelled Visa Explanation"
  * "Have you ever been refused a U.S. Visa, or been refused admission to the United States, or withdrawn your application for admission at the port of entry?" → Yes/No; if Yes, fill "Visa Refusal Explanation"
  * "Has anyone ever filed an immigrant petition on your behalf with the United States Citizenship and Immigration Services?" → Yes/No; if Yes, fill "Immigrant Petition Explanation"
  * If a field value is N/A in the applicant data and there is no "Does Not Apply" checkbox visible, skip the field entirely`,
}

/**
 * Build the complete planner system prompt for a given page context.
 * Used by plan-page.js.
 */
export function buildPlannerSystemPrompt(pageContext) {
  const pageRule = PAGE_RULES[pageContext] || ''
  return AGENT_CORE_RULES + (pageRule ? '\n' + pageRule : '')
}

// ─── Vision agent call ───────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are a browser automation agent filling a U.S. DS-160 nonimmigrant visa application form on behalf of an applicant.

You will receive:
1. A screenshot of the current page
2. The applicant's complete DS-160 data (translated English text)
3. A log of the last actions you have already executed

Your task: output EXACTLY ONE next action as a JSON object. No explanation. No markdown. Pure JSON only.

ACTION SCHEMA — choose exactly one:
{"type":"fill","label":"<exact visible label text on page>","value":"<text to type>"}
{"type":"selectOption","label":"<exact visible label text on page>","value":"<option text to select>"}
{"type":"radio","label":"<question label text>","value":"Yes OR No"}
{"type":"fill","label":"<repeated field label>","value":"<text>","occurrence":<1-based row number>}
{"type":"selectOption","label":"<repeated field label>","value":"<option>","occurrence":<1-based row number>}
{"type":"check","label":"<exact visible checkbox or label text>"}
{"type":"click","text":"<exact visible button or link text>"}
{"type":"uploadPhoto"}
{"type":"reviewNext"}
{"type":"solveCaptcha"}
{"type":"submitApplication"}
{"type":"wait"}
{"type":"defer","reason":"<why this optional/non-blocking item is being deferred>","fieldLabel":"<field or action>"}
{"type":"done"}

RULES:
- Output ONLY one action per response
- Testing continuity: If an optional field or an extra repeatable-row action cannot be completed after it has already failed, you may output {"type":"defer","reason":"<reason>","fieldLabel":"<field/action>"}. Never defer a required field, an unanswered Yes/No question, or any field named in VISIBLE VALIDATION ERRORS. After deferring, do not retry it; continue with the next field and leave it for human review.
- Use the EXACT visible text of the label as it appears on the current screenshot
- The translated source may contain questions that do not exist on the current DS-160 page. Only act on fields/questions actually visible in the UI. If a translated question is absent, skip it and continue to the next visible field; never attempt to fill or answer it.
- CRITICAL: Yes/No questions on the DS-160 are RADIO BUTTONS, not dropdowns. Always use {"type":"radio"} for Yes/No questions, NEVER use {"type":"fill"} or {"type":"selectOption"} for them
- Examples of radio button questions: "Have you ever used other names?", "Do you have a telecode that represents your name?", "Are you a permanent resident?", "Have you ever been in the United States?", etc.
- IMPORTANT: For radio actions, copy the "label" text EXACTLY as it appears on screen. The "value" must be exactly "Yes" or "No" (capitalised).
- Do NOT skip any Yes/No question — answer every one before clicking Next
- If VISIBLE VALIDATION ERRORS are provided, treat them as the highest priority. Read each message, identify the referenced field/question, and use APPLICANT DATA to output the corrective action before continuing normal form order.
- A validation summary can remain visible after its field is corrected. If ACTIONS ALREADY TAKEN shows that the latest post-navigation action already corrected the referenced field, retry the same Next/Save navigation action instead of repeating the correction.
- Use {"type":"selectOption"} for actual <select> dropdown menus. Key dropdown fields: Sex (use "MALE" or "FEMALE"), Marital Status (use "SINGLE", "MARRIED", "WIDOWED", "DIVORCED", "SEPARATED"), Country, State
- NEVER use {"type":"fill"} for Sex or Marital Status — these are <select> dropdowns, always use {"type":"selectOption"}
- For "Does Not Apply" checkboxes: {"type":"check","label":"Does Not Apply"}
- After selecting a dropdown or clicking a radio button that triggers dependent fields, output {"type":"wait"} once as your NEXT action to let them render. After that wait, continue to the next unanswered field. Never reselect a radio whose desired answer is already selected, and never repeat a completed radio action unless a visible validation error specifically requires it.
- For the security question setup: select "WHAT WAS YOUR HOME PHONE NUMBER WHEN YOU WERE A CHILD?" and enter answer "049824393"
- If you see a CAPTCHA image on the page: output {"type":"solveCaptcha"}
- If you see Cloudflare "Just a moment", "Performing security verification", or a "Verify you are human" checkbox: output {"type":"wait"}. Do not output solveCaptcha and do not try to click the widget — a human must complete it.
- If a field has N/A in the applicant data: check "Does Not Apply" if the checkbox is present, otherwise skip
- Phone number fields must be filled with digits only. Strip +, spaces, hyphens, and parentheses: "+972 538055645" → "972538055645".
- CRITICAL: For "Full Name in Native Alphabet" — if the applicant data contains a native-alphabet name (Hebrew, Arabic, or any non-Latin script), you MUST fill it using {"type":"fill"} and you MUST NEVER output {"type":"check"} or {"type":"click"} targeting "Does Not Apply" or "Technology Not Available" for this field — not before, not after, not ever. The checkbox must stay unchecked. After filling, move immediately to the next field. Only check "Does Not Apply" for this field if the applicant data explicitly has N/A or is completely absent for the native name.
- If a field has ❗ MISSING: skip it (leave blank), then continue. Never output {"type":"done"} because a value is missing
- Click "Next" or "Continue" only after ALL visible fields on the current section are filled. Use the EXACT visible button text (e.g. "Next: Personal 2", "Next: Work/Education", "Next: Security") — never shorten it to just "Next"
- Never output {"type":"done"} to stop the application. The run is only complete after Sign and Submit and the confirmation PDFs are saved. If this page has no more fields you can fill, click Next/Continue.
- On the Sign and Submit page, complete fields in this exact order: (1) answer "Yes" to "Did anyone assist you in filling out this application?" and fill the JVisa preparer (organization JVISA, 27 Hermon Street, Nahariya 2220527, Israel, relationship Clerk; preparer personal names Does Not Apply), (2) fill "Enter your Passport/Travel Document Number" from the applicant's passport data, (3) output {"type":"solveCaptcha"}. After CAPTCHA is solved, the code verifies the preparer, passport, and CAPTCHA and clicks "Sign and Submit Application".
- Never use a generic click action for "Sign and Submit Application"; only the guarded submitApplication action may click it.
- If you are on a preview/review screen (no editable fields visible), output {"type":"reviewNext"} to advance to the next review section. Repeat on every review page until Sign and Submit is reached.
- Fill fields in top-to-bottom, left-to-right order as they appear on screen
- DS-160 exact label names: city of birth is labeled "City"; state/province of birth is labeled "State/Province" — if the applicant data has N/A or no value for that field, output {"type":"check","label":"Does Not Apply","fieldLabel":"State/Province"} to check its "Does Not Apply" checkbox; only use {"type":"fill","label":"State/Province"} when there is an actual value; country of birth is labeled "Country/Region of Birth" and is a <select> dropdown — always use {"type":"selectOption"} for it
- For Date of Birth always use {"type":"fill","label":"Date of Birth","value":"DD/MM/YYYY"} — the code handles splitting into the Day/Month/Year dropdowns automatically. Never use selectOption for date fields
- Personal Information 2 rules:
  * "Are you a permanent resident of a country/region other than your country/region of origin?" is a radio button — use {"type":"radio"} with Yes or No
  * National Identification Number — always fill with the value (Israeli ID number); NEVER check "Does Not Apply" for this field
  * U.S. Social Security Number — if the applicant has a value, fill it; if absent/N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Social Security Number"}
  * U.S. Taxpayer ID Number — if the applicant has a value, fill it; if absent/N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Taxpayer ID"}
- Travel Information rules:
  * "Purpose of Trip to the U.S." is a <select> dropdown — use {"type":"selectOption","label":"Purpose of Trip to the U.S.","value":"TEMP. BUSINESS OR PLEASURE VISITOR (B)"} (or whichever class matches). After selecting, output {"type":"wait"} — a second "Specify" dropdown will appear
  * "Specify" dropdown — use {"type":"selectOption","label":"Specify","value":"BUSINESS OR TOURISM (TEMPORARY VISITOR) (B1/B2)"} (or the most specific match). After selecting, output {"type":"wait"}
  * "Have you made specific travel plans?" is a radio button — use {"type":"radio"} with Yes or No. After answering, output {"type":"wait"}
  * If YES to specific travel plans: fill arrival city, arrival date fields. State field for destination is a <select> dropdown — use {"type":"selectOption"}
  * If NO to specific travel plans: for "Intended Date of Arrival" output {"type":"fill","label":"Intended Date of Arrival","value":"DD/MM/YYYY"} — the code automatically fills the Day dropdown (options 1–31), the Month dropdown (3-letter: JAN/FEB…DEC), and the Year text input; for "Intended Length of Stay in U.S." output TWO actions: first {"type":"fill","label":"Intended Length of Stay in U.S.","value":"<integer>"} for the quantity — the value MUST be a whole integer with no decimals or fractions; if the duration is fractional, convert down to the next smaller unit to get a whole number (e.g. 1.5 months → 6 weeks; 0.5 years → 6 months; 2.5 weeks → 18 days); then {"type":"selectOption","label":"Intended Length of Stay in U.S.","value":"Month(s)"} for the unit — exact unit option texts are: "Year(s)", "Month(s)", "Week(s)", "Day(s)", "Less Than 24 Hours"
  * "Person/Entity Paying for Your Trip" is a <select> dropdown (the label on screen says "Person/Entity Paying for Your Trip") — use {"type":"selectOption","label":"Person/Entity Paying for Your Trip","value":"<option>"} with the exact option text: "Self", "Other Person", "Present Employer", "Employer in the U.S.", or "Other Company/Organization". After selecting, output {"type":"wait"} — if not Self, additional fields will appear
  * If "Other Person" is selected, fill the payer's sub-fields in this order:
    1. Surnames (last name) — {"type":"fill","label":"Surnames of Person Paying for Trip","value":"<last name>"}
    2. Given Names (first name) — {"type":"fill","label":"Given Names of Person Paying for Trip","value":"<first name>"}
    3. Phone Number — {"type":"fill","label":"Telephone Number of Person Paying for Trip","value":"<phone>"}
    4. Email Address — {"type":"fill","label":"Email Address of Person Paying for Trip","value":"<email>"} — the code automatically unchecks "Does Not Apply" before filling; if the payer has no email, skip this field (leave "Does Not Apply" checked)
    5. Relationship — {"type":"selectOption","label":"Relationship to You","value":"<relationship>"} — exact option values on screen: "CHILD", "PARENT", "SPOUSE", "OTHER RELATIVE", "FRIEND", "OTHER". If the relationship is not explicitly stated in the payer data, infer it from the Travel Companions section (e.g. if the payer's name appears as a companion with "Relationship: Son", the payer is your CHILD)
    6. Address Same — answer the radio: {"type":"radio","label":"Is the address of the party paying for your trip the same as your Home or Mailing Address?","value":"Yes"} or "No". Answer Yes only if the payer's address is identical to the applicant's home/mailing address; otherwise answer No
    7. Street Address (only if No to step 6) — {"type":"fill","label":"Street Address of Person Paying for Trip","value":"<address>"}
    For the "Name" field in the applicant data (e.g., "OREN KOFMAN"), split it: last word(s) = Surname, first word(s) = Given Name
  * If "Other Company/Organization" is selected, the extra fields are inside the payer panel. Relationship is a free-text box, not the Other Person dropdown. Never put these values in the U.S. stay Street Address or City fields. Use these actions, in order:
    1. {"type":"fill","label":"Name of Company/Organization Paying for Trip","value":"<organization>"}
    2. {"type":"fill","label":"Telephone Number of Company Paying","value":"<digits only>"}
    3. {"type":"fill","label":"Relationship of Company Paying","value":"<role, for example Advisor to the Ministry Director General>"}
    4. {"type":"fill","label":"Payer Company Street Address (Line 1)","value":"<street only>"}
    5. When a second line exists: {"type":"fill","label":"Payer Company Street Address (Line 2)","value":"<line 2>"}
    6. {"type":"fill","label":"Payer Company City","value":"<city>"}
    7. If there is no state/province, {"type":"check","label":"Does Not Apply","fieldLabel":"Payer Company State/Province"}. Otherwise {"type":"fill","label":"Payer Company State/Province","value":"<state>"}
    8. If a postal code is present, {"type":"fill","label":"Payer Company Postal Zone/ZIP Code","value":"<code>"}. If it is missing or DOES NOT APPLY, {"type":"check","label":"Does Not Apply","fieldLabel":"Payer Company Postal Zone/ZIP Code"}
    9. {"type":"selectOption","label":"Payer Company Country/Region","value":"<country, for example ISRAEL>"}
    A single address line such as "Kanfei Nesharim 5, Jerusalem, Israel" splits into street "Kanfei Nesharim 5", city "Jerusalem", country "ISRAEL", and Does Not Apply for State/Province.
- Travel Companions rules:
  * Answer "Are there other persons traveling with you?" once. If Yes, wait once for the dependent section.
  * Answer "Are you traveling as part of a group or organization?" once. For individually named companions this must be No; then wait once for the companion rows.
  * Fill each individual row in this order using the same 1-based occurrence for all three actions: "Surnames of Person Traveling With You", "Given Names of Person Traveling With You", then "Relationship with Person".
  * Relationship is a dropdown. Map Spouse → "SPOUSE", Child/Son/Daughter → "CHILD", Parent/Mother/Father → "PARENT", other family relationships → "OTHER RELATIVE", Friend → "FRIEND", otherwise → "OTHER".
  * Before companion occurrence 2 or later, output {"type":"click","text":"Add Another Travel Companion"} exactly once, then fill the newly added row. Do not click Next until every companion in APPLICANT DATA has a completed row.
- Address and Phone page — home address fields are separate controls. Use these exact actions and never reuse the street-address label for the ZIP value:
  * {"type":"fill","label":"Street Address (Line 1)","value":"<street address only>"}
  * {"type":"fill","label":"Street Address (Line 2)","value":"<optional second line>"} when present
  * {"type":"fill","label":"City","value":"<home city>"}
  * {"type":"fill","label":"State/Province","value":"<home state>"} or check Does Not Apply
  * {"type":"fill","label":"Postal Zone/ZIP Code","value":"<postal code only>"}
  * {"type":"selectOption","label":"Country/Region","value":"<home country>"}
  * If Postal Zone/ZIP Code is unknown or N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Postal Code"} instead of filling it
  * Answer "Is your Mailing Address the same as your Home Address?". If No, fill every displayed mailing field with these actions: {"type":"fill","label":"Mailing Street Address (Line 1)","value":"<street>"}, {"type":"fill","label":"Mailing Street Address (Line 2)","value":"<optional>"}, {"type":"fill","label":"Mailing City","value":"<city>"}, {"type":"fill","label":"Mailing State/Province","value":"<state>"}, {"type":"fill","label":"Mailing Postal Zone/ZIP Code","value":"<postal>"}, and {"type":"selectOption","label":"Mailing Country/Region","value":"<country>"}. Never use bare home-address labels for mailing values.
  * Process the PHONE section before the EMAIL ADDRESS section.
  * If Secondary Phone Number is N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Secondary Phone"}.
  * If Work Phone Number is N/A, output {"type":"check","label":"Does Not Apply","fieldLabel":"Work Phone"}.
  * After answering Yes to "Have you used any other phone numbers in the last five years?", fill {"type":"fill","label":"Additional Phone Number","value":"<number>","occurrence":1}. Before each later number, output {"type":"click","text":"Add Another Phone"}, then fill occurrence 2, 3, etc.
  * In EMAIL ADDRESS, fill "Email Address" first, then answer "Have you used any other email addresses in the last five years?"
  * If other emails is Yes, fill {"type":"fill","label":"Additional Email Address","value":"<email>","occurrence":1}. Before each later email output {"type":"click","text":"Add Another Email"}, then use occurrence 2, 3, etc.
  * SOCIAL MEDIA is not a Yes/No field. If the source says No to social media in the last 5 years, lists None, or has no platform accounts, immediately select {"type":"selectOption","label":"Social Media Provider/Platform","value":"NONE","occurrence":1} and do not leave "- SELECT ONE -". For each listed account, select {"type":"selectOption","label":"Social Media Provider/Platform","value":"FACEBOOK","occurrence":1}, wait for the postback, then fill {"type":"fill","label":"Social Media Identifier","value":"<username or handle, not password>","occurrence":1}. Infer provider and handle from URLs when necessary. Before each later account output {"type":"click","text":"Add Another Social Media"}, then use occurrence 2, 3, etc.
  * Finally answer the separate radio question beginning "Do you wish to provide information about your presence on any other websites or applications...".
- Passport Information page rules:
  * Passport/Travel Document Type is a dropdown: {"type":"selectOption","label":"Passport/Travel Document Type","value":"REGULAR"}
  * Passport number: {"type":"fill","label":"Passport/Travel Document Number","value":"<number>"}
  * If Passport Book Number is No/N/A, check "Does Not Apply" for that field.
  * Country/Authority that Issued Passport/Travel Document is a dropdown: {"type":"selectOption","label":"Country/Authority that Issued Passport/Travel Document","value":"<country>"}. Match the visible country option (for example Israel selects option value ISRL).
  * Place of issuance fields use synthetic labels so they route unambiguously: "Passport Issuance City", "Passport Issuance State/Province", and "Passport Issuance Country/Region".
  * Issuance Date — always use {"type":"fill","label":"Issuance Date","value":"DD/MM/YYYY"} — the code automatically fills the Day dropdown, the Month dropdown (3-letter: JAN/FEB…DEC), and the Year text input. NEVER use selectOption for date fields
  * Expiration Date — always use {"type":"fill","label":"Expiration Date","value":"DD/MM/YYYY"} — same automatic splitting applies
  * Only when the source explicitly says there is no expiration date, output {"type":"check","label":"No Expiration"}. Never use this checkbox for the lost/stolen-passport question.
  * "Have you ever lost a passport or had one stolen?" is a radio: Yes selects rblLOST_PPT_IND_0 and No selects rblLOST_PPT_IND_1.
  * If Yes, use occurrence 1 for: "Lost Passport/Travel Document Number", "Lost Passport Country/Authority", and "Lost Passport Explanation". If the number is unknown, output {"type":"check","label":"Do Not Know","fieldLabel":"Lost Passport Number","occurrence":1}.
- U.S. Point of Contact page rules:
  * This page is mandatory. APPLICANT DATA must provide either a complete contact-person name or an organization name, plus relationship, street, city, state, and phone.
  * Use only values under the U.S. CONTACT INFORMATION section. Never reuse travel accommodation, the applicant's own phone/address, or another section's values.
  * Never copy examples, hints, or placeholders from the page. In particular, "5555555555" is a UI example and must never be used unless it explicitly appears in APPLICANT DATA.
  * If required contact data is marked ❗ MISSING, skip inventing a value. Check Do Not Know / Does Not Apply when those boxes exist, then click Next. Never output {"type":"done"}.
  * Organization Name — if present use {"type":"fill","label":"Organization Name","value":"<organization>"}
  * If Organization Name is N/A or unknown, check the form's "Do Not Know" checkbox with {"type":"check","label":"Do Not Know","fieldLabel":"U.S. Point of Contact Organization Name"}
  * Phone Number — use {"type":"fill","label":"Phone Number","value":"<phone>"}; this maps directly to tbxUS_POC_HOME_TEL
  * Email Address — when present use {"type":"fill","label":"Email Address","value":"<email>"}; this maps directly to tbxUS_POC_EMAIL_ADDR
  * Only if the source explicitly says the contact email is N/A or absent, use {"type":"check","label":"Does Not Apply","fieldLabel":"U.S. Point of Contact Email Address"}. Never check it when an email value exists.
- Family Information page rules:
  * The form repeats "Surnames" and "Given Names" labels for Father, Mother, and U.S. Relatives — you MUST prefix the label with the family member so the code routes it to the correct field:
    - Father section: {"type":"fill","label":"Father Surnames","value":"..."} and {"type":"fill","label":"Father Given Names","value":"..."}
    - Mother section: {"type":"fill","label":"Mother Surnames","value":"..."} and {"type":"fill","label":"Mother Given Names","value":"..."}
    - U.S. Relative section: {"type":"fill","label":"Relative Surnames","value":"..."} and {"type":"fill","label":"Relative Given Names","value":"..."}
  * For "Do Not Know" DOB checkboxes, always include a fieldLabel that names the parent: {"type":"check","label":"Do Not Know","fieldLabel":"Father Date of Birth"} or {"type":"check","label":"Do Not Know","fieldLabel":"Mother Date of Birth"}
  * Father's Date of Birth — if N/A: {"type":"check","label":"Do Not Know","fieldLabel":"Father Date of Birth"}; if known: {"type":"fill","label":"Father Date of Birth","value":"DD/MM/YYYY"}
  * Mother's Date of Birth — if N/A: {"type":"check","label":"Do Not Know","fieldLabel":"Mother Date of Birth"}; if known: {"type":"fill","label":"Mother Date of Birth","value":"DD/MM/YYYY"}
  * "Is your father in the U.S.?" and "Is your mother in the U.S.?" are radio buttons — use {"type":"radio"}
  * "Do you have any immediate relatives, not including parents, in the United States?" is a radio button
  * "Do you have any other relatives in the United States?" is a radio button
  * Father's Status and Mother's Status are <select> dropdowns — use {"type":"selectOption"}. Options are: "U.S. CITIZEN", "U.S. LEGAL PERMANENT RESIDENT (LPR)", "NONIMMIGRANT", "OTHER/I DON'T KNOW". Use "OTHER/I DON'T KNOW" when status is not known or not applicable
  * "Relationship to You" and "Relative's Status" for U.S. relatives are <select> dropdowns
- Spouse Information page rules:
  * Use values only from the 🟦 SPOUSE INFORMATION section. Never copy a name from RELATIVES IN THE U.S., U.S. CONTACT INFORMATION, or TRAVEL COMPANIONS.
  * Fill "Spouse's Surnames" from Spouse Surname and "Spouse's Given Names" from Spouse Given Name.
  * Before navigating, verify the entered spouse name exactly matches those two spouse-source fields.
- Previous Work / Education page:
  * Never type the literal value "N/A", "DOES NOT APPLY", or "DO NOT KNOW" into a previous-employer or education input when its row has a checkbox.
  * For each previous employer row, when State/Province or ZIP is N/A/DOES NOT APPLY, use {"type":"check","label":"Does Not Apply","fieldLabel":"Previous Employer State/Province","occurrence":1} or fieldLabel "Previous Employer Postal Zone/ZIP Code".
  * When a previous supervisor surname or given names are N/A/DO NOT KNOW/unknown, use {"type":"check","label":"Do Not Know","fieldLabel":"Previous Employer Supervisor Surname","occurrence":1} and fieldLabel "Previous Employer Supervisor Given Names". Never fill those marker values into the name inputs.
  * Previous employment dates must use {"type":"fill","label":"Start Date","value":"DD/MM/YYYY","occurrence":1} and {"type":"fill","label":"End Date","value":"DD/MM/YYYY","occurrence":1}. Both actions fill Day, Month, and Year.
  * Always answer "Have you attended any educational institutions at a secondary level or above?" using {"type":"radio"} before filling education rows.
  * Fill previous-employer city with {"type":"fill","label":"Employer City","value":"<city>","occurrence":1}. Never use the bare "City" label for the employer — that label is shared with education on the same page.
  * Fill each education city with {"type":"fill","label":"Education City","value":"<city>","occurrence":1}. Never use the bare "City" label for education.
  * For each education row, when State/Province or ZIP is N/A/DOES NOT APPLY, check Does Not Apply with fieldLabel "Education State/Province" or "Education Postal Zone/ZIP Code" and the matching occurrence.
  * Education dates use labels "Attendance From" and "Attendance To" with DD/MM/YYYY and the matching occurrence.
- Additional Work / Education page:
  * Fill the first language with {"type":"fill","label":"Language Name","value":"<language>","occurrence":1}.
  * Before each later language, use exactly {"type":"click","text":"Add Another Language"}, then fill "Language Name" with occurrence 2, 3, etc.
  * Never use generic {"type":"click","text":"Add Another"} for languages; that action is reserved for previous U.S. visits.
  * Answer every Yes/No question on this page, including clan/tribe, countries visited, organizations, specialized skills, military service, and paramilitary/insurgent organizations.
  * For visited countries use "Country Visited"; before later rows use "Add Another Visited Country".
  * For organizations use "Organization Name"; before later rows use "Add Another Organization".
  * If specialized skills is Yes, fill {"type":"fill","label":"Specialized Skills Explanation","value":"<details>"}.
  * Military fields use "Military Service Country", "Branch of Service", "Rank/Position", "Military Specialty", "Service From", and "Service To". Dates use DD/MM/YYYY and every action uses the same 1-based occurrence. Before a later military record, use "Add Another Military Service".
  * If paramilitary/insurgent involvement is Yes, fill {"type":"fill","label":"Paramilitary/Insurgent Explanation","value":"<details>"}.
- Present Work / Education page:
  * Current employment Start Date must use {"type":"fill","label":"Start Date","value":"DD/MM/YYYY"}. The code fills ddlEmpDateFromDay, ddlEmpDateFromMonth, and tbxEmpDateFromYear.
  * "Briefly describe your duties:" is required. Use the source's Describe Your Duties value when available. If it is missing/N/A and Primary Occupation is STUDENT, fill "Studying". For any other occupation with this visible field and no duties data, fill "Performing the regular duties associated with my position." Never skip this visible field and never enter "N/A".
- Security and Background pages 1–5:
  * Every visible question is a Yes/No radio and must be answered when its corresponding source item exists.
  * The source uses short labels such as "Communicable diseases", "Arrests or convictions", "Espionage", and "Immigration fraud". You may use those exact short source labels in radio actions; the code maps them to the full legal question and confirmed radio ID.
  * Process each source security item once in screen order. Do not use generic unscoped Yes/No controls.
- Photo page (development/test flow only):
  * On the DS-160 Upload Photo page, output {"type":"click","text":"Upload Your Photo"}.
  * When the external photo tool displays a file input, output {"type":"uploadPhoto"}. The code attaches a generated 600×600 JPEG under 240 KB.
  * The generated image is blank and is expected to fail biometric/face validation. Never claim that it is an approved applicant photo.
  * If photo validation fails and the UI displays "Next: Continue Without a Photo", output {"type":"click","text":"Continue Without a Photo"}. The code targets btnNoImage directly.
  * On the Confirm Photo page, output {"type":"click","text":"Review"}. The code clicks btnReviewPage when its completion modal is visible, otherwise the confirmed REVIEW navigation tab.
- Previous U.S. Travel page — process fields strictly in the following screen order. Every Yes/No question is a radio button; use {"type":"radio"} with the label copied EXACTLY as it appears on screen:
  * "Have you ever been in the United States?" → Yes/No
  * If Yes, fill every previous visit in source order. These are repeated fields, so always use these synthetic labels and the same 1-based occurrence for all three actions in a row:
    1. Arrival date: {"type":"fill","label":"Previous Visit Arrival Date","value":"DD/MM/YYYY","occurrence":1}
    2. Stay quantity: {"type":"fill","label":"Previous Visit Length of Stay","value":"<integer>","occurrence":1}
    3. Stay unit: {"type":"selectOption","label":"Previous Visit Length of Stay","value":"Month(s)","occurrence":1}
  * Exact stay-unit options are "Year(s)", "Month(s)", "Week(s)", "Day(s)", and "Less Than 24 Hours". Convert source units to the matching option.
  * Before visit 2 and each later visit, output exactly {"type":"click","text":"Add Another"}. The code waits for the new row. Then repeat the three actions with occurrence 2, 3, etc. Never refill occurrence 1 with a later visit's data, and never try to fill an occurrence before adding its row.
  * Next answer "Do you or did you ever hold a U.S. Driver’s License?". If Yes, fill "Driver's License Number" and select "State of Driver's License" with occurrence 1. Before each later license output {"type":"click","text":"Add Another Driver's License"}, then use occurrence 2, 3, etc. If a number is unknown, check "Do Not Know" with fieldLabel "Driver's License Number" and the matching occurrence.
  * Next answer "Have you ever been issued a U.S. Visa?". If Yes, process its fields in this exact order:
    1. {"type":"fill","label":"Date Last Visa Was Issued","value":"DD/MM/YYYY"}
    2. {"type":"fill","label":"Visa Number","value":"<number>"}; if unknown, check "Do Not Know"
    3. Radio: "Are you applying for the same type of visa?"
    4. Radio: "Are you applying in the same country or location where the visa above was issued, and is this country or location your place of principal of residence?"
    5. Radio: "Have you been ten-printed?"
    6. Radio: "Has your U.S. Visa ever been lost or stolen?"; if Yes, fill "Lost Visa Year" and "Lost Visa Explanation"
    7. Radio: "Has your U.S. Visa ever been cancelled or revoked?"; if Yes, fill "Cancelled Visa Explanation"
  * "Have you ever been refused a U.S. Visa, or been refused admission to the United States, or withdrawn your application for admission at the port of entry?" → Yes/No; if Yes, fill "Visa Refusal Explanation"
  * "Has anyone ever filed an immigrant petition on your behalf with the United States Citizenship and Immigration Services?" → Yes/No; if Yes, fill "Immigrant Petition Explanation"
  * If a field value is N/A in the applicant data and there is no "Does Not Apply" checkbox visible, skip the field entirely`

/**
 * Read visible ASP.NET validation summaries so the agent can repair fields
 * rejected by the DS-160 before retrying navigation.
 */
export async function readVisibleValidationErrors(page) {
  const summaries = page.locator(
    '[id$="ValidationSummary"]:visible, .validation-summary-errors:visible, .error-message:visible',
  )
  const errors = []

  for (const summary of await summaries.all()) {
    const listItems = summary.locator('li')
    const count = await listItems.count().catch(() => 0)
    if (count > 0) {
      for (let index = 0; index < count; index++) {
        const text = (await listItems.nth(index).textContent().catch(() => ''))?.trim()
        if (text) errors.push(text)
      }
      continue
    }

    const text = (await summary.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim()
    if (text) errors.push(text)
  }

  return [...new Set(errors)]
}

/**
 * Ask the configured vision agent what the next action should be.
 * Returns a parsed action object.
 */
export async function askAgent(
  screenshotBuffer,
  translatedText,
  actionHistory,
  apiKey,
  validationErrors = [],
) {
  // Keep history short to avoid excessive token use (last 30 actions)
  const recentHistory = actionHistory.slice(-30)
  const historyText = recentHistory.length
    ? '\n\nACTIONS ALREADY TAKEN (most recent last):\n' +
      recentHistory.map((a, i) => `${i + 1}. ${JSON.stringify(a)}`).join('\n')
    : '\n\nNo actions taken yet — this is the first step.'
  const validationText = validationErrors.length
    ? '\n\nVISIBLE VALIDATION ERRORS (fix these before anything else):\n' +
      validationErrors.map((error, index) => `${index + 1}. ${error}`).join('\n')
    : ''

  const b64 = screenshotBuffer.toString('base64')

  log(`OpenAI browser-agent request model=${OPENAI_MODELS.autofill}`)
  const resp = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODELS.autofill,
      max_completion_tokens: 512,
      messages: [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' },
            },
            {
              type: 'text',
              text:
                'APPLICANT DATA:\n' +
                translatedText +
                historyText +
                validationText +
                '\n\nOutput the NEXT single action as JSON:',
            },
          ],
        },
      ],
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`OpenAI error ${resp.status}: ${errText.slice(0, 200)}`)
  }

  const json = await resp.json()
    const choice = json?.choices?.[0]
    const raw = choice?.message?.content?.trim() || ''
    if (!raw) {
      const refusal = choice?.message?.refusal
      const detail = refusal
        ? `refusal="${String(refusal).slice(0, 120)}"`
        : `finish_reason=${choice?.finish_reason || 'unknown'}`
      throw new Error(`Agent returned empty output (${detail})`)
    }

  // Strip markdown code fences if model wraps response
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    throw new Error(`Agent returned non-JSON: ${raw.slice(0, 200)}`)
  }
}

// ─── Page context detection ──────────────────────────────────────────────────

/**
 * Detect which DS-160 page/section the browser is currently on.
 *
 * PRIMARY: URL-based detection — each DS-160 section has a distinct .aspx filename.
 * FALLBACK: page heading text (h2/h3/legend), only if URL gives no match.
 * We deliberately avoid scanning the full body text because DS-160 keeps hidden
 * fields from previous pages in the DOM, causing false-positive matches.
 */
export async function detectCurrentPageContext(page) {
  try {
    const fromUrl = detectPageContextFromUrl(page.url())
    if (fromUrl !== 'unknown') return fromUrl

    for (const sel of ['h2', 'h3', 'legend', '.step-title']) {
      try {
        const text = (await page.locator(sel).first().textContent({ timeout: 500 })) || ''
        const fromHeading = detectPageContextFromHeading(text)
        if (fromHeading) return fromHeading
      } catch { /* try next */ }
    }

    return detectPageContextFromUrlFallback(page.url())
  } catch {
    return 'unknown'
  }
}

/**
 * Extract only the section(s) of the translated text relevant to the current page.
 * Falls back to the full text if context is unknown.
 */
export function filterTranslatedText(translatedText, pageContext) {
  const SECTION_PATTERNS = {
    personal1:    /PERSONAL INFORMATION 1[\s\S]*?(?=\nPERSONAL INFORMATION 2|\n🟦|$)/i,
    personal2:    /PERSONAL INFORMATION 2[\s\S]*?(?=\n🟦|$)/i,
    travel:       /🟦 TRAVEL INFORMATION[\s\S]*?(?=\n🟦|$)/i,
    companions:   /🟦 TRAVEL COMPANIONS[\s\S]*?(?=\n🟦|$)/i,
    prev_travel:  /🟦 PREVIOUS U\.?S\.? TRAVEL[\s\S]*?(?=\n🟦|$)/i,
    address:      /🟦 ADDRESS AND PHONE[\s\S]*?(?=\n🟦|$)/i,
    passport:     /🟦 PASSPORT[\s\S]*?(?=\n🟦|$)/i,
    contact:      /🟦 (?:U\.?S\.?\s+)?CONTACT[\s\S]*?(?=\n🟦|$)/i,
    family:       /🟦 FAMILY[\s\S]*?(?=\n🟦|$)/i,
    spouse:       /🟦 SPOUSE INFORMATION[\s\S]*?(?=\n🟦|$)/i,
    work_present: /🟦 WORK.*EDUCATION[\s\S]*?(?=\n🟦 PREVIOUS EMPLOYMENT|\n🟦 EDUCATION|\n🟦 ADDITIONAL BACKGROUND|$)/i,
    work_previous:/🟦 PREVIOUS EMPLOYMENT[\s\S]*?(?=\n🟦 ADDITIONAL BACKGROUND|\n🟦 SECURITY|$)/i,
    work_additional:/🟦 ADDITIONAL BACKGROUND[\s\S]*?(?=\n🟦 SECURITY|$)/i,
    work_edu:     /🟦 WORK.*EDUCATION[\s\S]*?(?=\n🟦 SECURITY|$)/i,
    security:     /🟦 SECURITY[\s\S]*?(?=\n🟦|$)/i,
    photo:        /🟦 UPLOAD A PHOTO[\s\S]*?(?=\n🟦|$)/i,
    sign_submit:  /🟦 PASSPORT[\s\S]*?(?=\n🟦|$)/i,
  }

  const pattern = SECTION_PATTERNS[pageContext]
  if (!pattern) return translatedText  // unknown page — send everything

  const match = translatedText.match(pattern)
  if (match) return match[0].trim()

  // No section matched. If the document is sectioned at all, this page genuinely
  // has no answers and must get nothing: returning the whole document instead
  // lets one page read another's values — a passport page picking up a parent's
  // date of birth fills a wrong date with no error anywhere.
  if (hasCanonicalSections(translatedText)) return ''

  // Otherwise the document is in a shape this function cannot segment, and the
  // whole text is the only thing left to offer. The caller is warned once.
  return translatedText
}

/** True when the document uses the section headers filterTranslatedText splits on. */
export function hasCanonicalSections(translatedText) {
  const text = String(translatedText ?? '')
  return text.includes('🟦') || /^\s*PERSONAL INFORMATION 1\b/im.test(text)
}

function sourceLineValue(sectionText, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(sectionText || '').match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'mi'))?.[1]?.trim() || ''
}

function sourceYesNo(sectionText, pattern) {
  const match = String(sectionText || '').match(pattern)
  if (!match) return null
  return /yes/i.test(match[1])
}

const prevTravelRequiredYes = {
  beenInUs: false,
  issuedVisa: false,
}

const STAY_UNIT_FROM_WORD = {
  day: 'Day(s)',
  days: 'Day(s)',
  week: 'Week(s)',
  weeks: 'Week(s)',
  month: 'Month(s)',
  months: 'Month(s)',
  year: 'Year(s)',
  years: 'Year(s)',
}

export const MAX_PREV_US_VISITS = 5

function prevVisitSortValue(date) {
  const [day, month, year] = String(date || '').split('/').map(Number)
  if (!year || !month || !day) return 0
  return Date.UTC(year, month - 1, day)
}

/** CEAC only stores 5 previous U.S. visits. Keep the most recent, oldest-first. */
export function capPrevUsVisits(visits, max = MAX_PREV_US_VISITS) {
  const list = Array.isArray(visits) ? visits : []
  if (list.length <= max) return list.slice()
  return list
    .slice()
    .sort((a, b) => prevVisitSortValue(b.date) - prevVisitSortValue(a.date))
    .slice(0, max)
    .sort((a, b) => prevVisitSortValue(a.date) - prevVisitSortValue(b.date))
}

export function parsePackedUsAddress(value) {
  const raw = String(value || '').trim()
  const packed = raw.match(
    /^(.+?),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)(?:,\s*(?:united states(?: of america)?))?\.?$/i,
  )
  if (!packed) return { street: raw, city: '', state: '', zip: '' }
  return {
    street: packed[1].trim(),
    city: packed[2].trim(),
    state: packed[3].toUpperCase(),
    zip: packed[4],
  }
}

async function fillEmptyTravelStayParts(page, packed) {
  if (packed.zip) {
    const zip = page.locator('input[id$="tbZIPCode"]').first()
    if (await zip.count() > 0 && !(await zip.inputValue().catch(() => '')).trim()) {
      await zip.fill(packed.zip)
    }
  }
  if (packed.state) {
    const state = page.locator('select[id$="ddlTravelState"]').first()
    if (await state.count() > 0) {
      const current = await state.evaluate((el) => {
        const opt = el.options[el.selectedIndex]
        return opt ? opt.value.trim() : ''
      }).catch(() => '')
      if (!current) {
        await state.selectOption({ value: packed.state }).catch(async () => {
          await state.selectOption({ label: packed.state }).catch(() => {})
        })
      }
    }
  }
}

export function parsePrevTravelFromSource(sectionText) {
  const text = String(sectionText || '')
  const beenInUsAnswer = sourceYesNo(
    text,
    /have you ever been in the (?:united states|u\.?s\.?)\?\s*(yes|no)/i,
  )
  const issuedVisaAnswer = sourceYesNo(
    text,
    /have you ever been issued a u\.?s\.? visa\?\s*(yes|no)/i,
  )

  const visits = []
  const lines = text.split('\n').map((line) => line.trim())
  for (let i = 0; i < lines.length; i++) {
    const dateMatch = lines[i].match(/^Arrival Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*$/i)
    if (!dateMatch) continue
    const stayMatch = (lines[i + 1] || '').match(
      /^Length of Stay:\s*(\d+)\s*(days?|weeks?|months?|years?)\s*$/i,
    )
    if (!stayMatch) continue
    visits.push({
      date: dateMatch[1],
      quantity: stayMatch[1],
      unit: STAY_UNIT_FROM_WORD[stayMatch[2].toLowerCase()] || 'Day(s)',
    })
  }

  const visaNumber = sourceLineValue(text, 'Visa Number')
  const visaLooksReal = Boolean(visaNumber) && !/^n\/?a|do not know|does not apply$/i.test(visaNumber)

  return {
    // Infer Yes from listed visits/visa numbers so a missed question never clicks No.
    beenInUs: beenInUsAnswer === true || visits.length > 0,
    issuedVisa: issuedVisaAnswer === true || visaLooksReal,
    beenInUsAnswer,
    issuedVisaAnswer,
    visits,
    driverLicense: sourceYesNo(
      text,
      /(?:do you or did you ever )?hold a u\.?s\.? driver.?s license\?\s*(yes|no)/i,
    ),
    visaDate: sourceLineValue(text, 'Date Last Visa Was Issued'),
    visaNumber,
    sameType: sourceYesNo(text, /same type of visa\?\s*(yes|no)/i),
    sameCountry: sourceYesNo(
      text,
      /same country or location where the visa[^\n]*\?\s*(yes|no)/i,
    ),
    tenPrinted: sourceYesNo(text, /have you been ten-printed\?\s*(yes|no)/i),
    lost: sourceYesNo(text, /visa ever been lost or stolen\?\s*(yes|no)/i),
    cancelled: sourceYesNo(text, /visa ever been cancelled or revoked\?\s*(yes|no)/i),
  }
}

function stripPayerBlock(text) {
  return String(text || '').replace(
    /\n?\*{0,2}PERSON\/ENTITY PAYING\b[\s\S]*?(?=\n🟦|$)/i,
    '\n',
  )
}

function travelSectionText(text) {
  const match = String(text || '').match(/🟦 TRAVEL INFORMATION[\s\S]*?(?=\n🟦|$)/i)
  return match ? match[0] : String(text || '')
}

function usContactAddressBlock(text) {
  const match = String(text || '').match(
    /\*{0,2}U\.S\. ADDRESS\*{0,2}[\s\S]*?(?=\n\*{0,2}CONTACT DETAILS\*{0,2}|\n🟦|$)/i,
  )
  return match?.[0] || ''
}

function readStayAddressLines(sectionText) {
  const streetRaw = sourceLineValue(sectionText, 'Street Address (Line 1)')
    || sourceLineValue(sectionText, 'Street Address')
  return splitUsStayAddress({
    street: streetRaw,
    city: sourceLineValue(sectionText, 'City'),
    state: sourceLineValue(sectionText, 'State'),
    zip: sourceLineValue(sectionText, 'ZIP Code')
      || sourceLineValue(sectionText, 'Postal Zone/ZIP Code'),
  })
}

export function parseUsStayAddressFromSource(sectionText) {
  // The payer block lives in TRAVEL INFORMATION and uses the same street/city
  // labels. It is an address in Israel. The stay address is the U.S. hotel.
  const stayScope = stripPayerBlock(travelSectionText(sectionText))
  let split = readStayAddressLines(stayScope)
  if (!split.street && !split.city) {
    split = readStayAddressLines(usContactAddressBlock(sectionText))
  }
  if ((split.street || split.city) && isMarkerValue(split.zip)) split.zip = UNKNOWN_US_STAY_ZIP
  return split
}

export function sourceUsedSocialMedia(sectionText) {
  const used = sourceYesNo(
    sectionText,
    /have you used social media(?: platforms)? in the last (?:5|five) years\?\s*(yes|no)\b/i,
  )
  if (used !== null) return used
  return sourceYesNo(
    sectionText,
    /do you have a social media presence\?\s*(yes|no)\b/i,
  )
}

export function parseSocialMediaFromSource(sectionText) {
  const accounts = []
  for (const rawLine of String(sectionText || '').split('\n')) {
    const line = rawLine.trim()
    const match = line.match(
      /^(Facebook|Instagram|Twitter|LinkedIn|YouTube|Pinterest|Reddit|Tumblr|Flickr|Ask\.fm):\s*(.+)$/i,
    )
    if (!match) continue
    const identifier = socialMediaIdentifier(match[2])
    if (!identifier) continue
    accounts.push({
      platform: match[1].toUpperCase().replace('ASK.FM', 'ASK.FM'),
      identifier,
    })
  }
  return accounts
}

export function socialMediaIdentifier(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw)
      const skip = new Set(['share', 'p', 'reel', 'reels', 'stories', 'watch', 'profile.php'])
      const handle = url.pathname.split('/').filter(Boolean).find(
        (part) => !skip.has(part.toLowerCase()),
      )
      return String(handle || '').replace(/^@/, '')
    }
  } catch { /* not a URL */ }
  return raw.replace(/^@/, '').split(/[/?#]/)[0].trim()
}

async function attachYesPostback(radio) {
  const hasPostback = await radio.evaluate((el) =>
    /__doPostBack/.test(el.getAttribute('onclick') || ''),
  )
  if (hasPostback) return false
  await radio.evaluate((el) => {
    const target = `${el.name}$0`
    el.setAttribute(
      'onclick',
      `javascript:setDirty();setTimeout(${JSON.stringify(`__doPostBack('${target}','')`)}, 0)`,
    )
  })
  return true
}

async function clickPrevTravelRadio(page, yesId, noId, wantYes, waitForSelector = '') {
  const targetId = wantYes ? yesId : noId
  const targetRadio = page.locator(`input[id$="${targetId}"]`).first()
  if (await targetRadio.count() === 0) return false
  const alreadyChecked = await targetRadio.isChecked().catch(() => false)
  if (alreadyChecked && !waitForSelector) return false
  if (alreadyChecked && waitForSelector && await page.locator(waitForSelector).count() > 0) {
    return false
  }

  await targetRadio.scrollIntoViewIfNeeded().catch(() => {})
  const needsExpand = Boolean(
    wantYes && waitForSelector && await page.locator(waitForSelector).count() === 0,
  )
  if (needsExpand) await attachYesPostback(targetRadio)
  await targetRadio.click()
  if (needsExpand) {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(400)
  } else {
    await page.waitForTimeout(200)
  }

  if (needsExpand && await page.locator(waitForSelector).count() === 0) {
    logWarn(`[prev_travel] ${waitForSelector} missing after Yes — retrying with postback`)
    await attachYesPostback(targetRadio)
    await targetRadio.click()
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    await page.locator(waitForSelector).first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {})
  }
  return true
}

export async function syncSpouseNameFromSource(page, sectionText) {
  const surname = sourceLineValue(sectionText, 'Spouse Surname')
  const givenName = sourceLineValue(sectionText, 'Spouse Given Name')
  // Writes straight to the inputs, so the marker guard in executeAction cannot
  // catch an "N/A" here.
  if (isMarkerValue(surname) || isMarkerValue(givenName)) return false

  const fields = [
    {
      locator: page.locator('input[id$="tbxSpouseSurname"]').first(),
      value: surname,
      label: 'surname',
    },
    {
      locator: page.locator('input[id$="tbxSpouseGivenName"]').first(),
      value: givenName,
      label: 'given names',
    },
  ]
  let changed = false
  for (const field of fields) {
    if (!await field.locator.isVisible().catch(() => false)) return false
    const current = await field.locator.inputValue().catch(() => '')
    if (current.trim().toUpperCase() === field.value.toUpperCase()) continue
    await field.locator.fill(field.value)
    log(`Corrected spouse ${field.label} from the SPOUSE INFORMATION source section`)
    changed = true
  }
  return changed
}

/**
 * Deterministically answer the Previous U.S. Travel gating radios and fill
 * every prior visit and visa field from the source text. The planner still
 * handles leftover Yes/No questions (refused visa, immigrant petition).
 *
 * Returns true if any radio or field was changed.
 */
export async function syncPrevTravelFromSource(page, sectionText) {
  const indicator = page.locator('input[id$="rblPREV_US_TRAVEL_IND_0"]')
  if (await indicator.count() === 0) return false

  const parsed = parsePrevTravelFromSource(sectionText)
  prevTravelRequiredYes.beenInUs = parsed.beenInUs
  prevTravelRequiredYes.issuedVisa = parsed.issuedVisa

  let changed = false
  const visitRowSelector = 'input[type="text"][id*="tbxPREV_US_VISIT_LOS"], input[type="number"][id*="PREV_US_VISIT"][id*="LOS"]'
  const visaFieldSelector = 'input[id$="tbxPREV_VISA_FOIL_NUMBER"]'

  if (parsed.beenInUs) {
    if (await clickPrevTravelRadio(page, 'rblPREV_US_TRAVEL_IND_0', 'rblPREV_US_TRAVEL_IND_1', true, visitRowSelector)) {
      log('[prev_travel] Set "ever been in the U.S.?" to Yes')
      changed = true
    }
  } else if (parsed.beenInUsAnswer === false) {
    if (await clickPrevTravelRadio(page, 'rblPREV_US_TRAVEL_IND_0', 'rblPREV_US_TRAVEL_IND_1', false)) {
      log('[prev_travel] Set "ever been in the U.S.?" to No')
      changed = true
    }
  }

  if (parsed.issuedVisa) {
    if (await clickPrevTravelRadio(page, 'rblPREV_VISA_IND_0', 'rblPREV_VISA_IND_1', true, visaFieldSelector)) {
      log('[prev_travel] Set "ever issued a U.S. visa?" to Yes')
      changed = true
    }
  } else if (parsed.issuedVisaAnswer === false) {
    if (await clickPrevTravelRadio(page, 'rblPREV_VISA_IND_0', 'rblPREV_VISA_IND_1', false)) {
      log('[prev_travel] Set "ever issued a U.S. visa?" to No')
      changed = true
    }
  }

  if (parsed.beenInUs && parsed.visits.length) {
    const visitsToFill = capPrevUsVisits(parsed.visits)
    if (visitsToFill.length < parsed.visits.length) {
      const omitted = parsed.visits
        .filter((visit) => !visitsToFill.some((kept) => kept.date === visit.date && kept.quantity === visit.quantity))
        .map((visit) => `${visit.date} (${visit.quantity} ${visit.unit})`)
        .join(', ')
      logWarn(
        `[prev_travel] CEAC allows ${MAX_PREV_US_VISITS} previous U.S. visits; ` +
        `omitting oldest: ${omitted}`,
      )
    }
    const stayInputs = page.locator(
      'input[type="text"][id*="tbxPREV_US_VISIT_LOS"], input[type="number"][id*="PREV_US_VISIT"][id*="LOS"]',
    )
    const addLinks = page.locator(
      'a[id*="InsertButtonPREV_US_VISIT"], a[title="Add Another"][href*="PREV_US_VISIT"]',
    )
    await stayInputs.first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {})
    if (await stayInputs.count() === 0) {
      throw new Error(
        'Previous U.S. visit rows did not appear after answering Yes. The Yes radio likely needs an ASP.NET postback.',
      )
    }
    while (await stayInputs.count() < visitsToFill.length) {
      if (await addLinks.count() === 0) {
        logWarn(`[prev_travel] Add Another is gone after ${await stayInputs.count()} row(s)`)
        break
      }
      const before = await stayInputs.count()
      try {
        await executeAction(page, { type: 'click', text: 'Add Another' })
      } catch (err) {
        logWarn(`[prev_travel] Could not add visit row ${before + 1}: ${err.message}`)
        break
      }
      if (await stayInputs.count() <= before) {
        logWarn('[prev_travel] Add Another did not create a new visit row')
        break
      }
      changed = true
    }
    const rowCount = await stayInputs.count()
    const yearInputs = page.locator('input[id*="PREV_US_VISIT_DTE"][id*="Year"]')
    for (let i = 0; i < visitsToFill.length && i < rowCount; i++) {
      const visit = visitsToFill[i]
      const occurrence = i + 1
      const currentQty = await stayInputs.nth(i).inputValue().catch(() => '')
      const currentYear = await yearInputs.nth(i).inputValue().catch(() => '')
      const expectedYear = visit.date.split('/')[2]
      if (currentQty.trim() === visit.quantity && currentYear.trim() === expectedYear) continue
      await executeAction(page, {
        type: 'fill',
        label: 'Previous Visit Arrival Date',
        value: visit.date,
        occurrence,
      })
      await executeAction(page, {
        type: 'fill',
        label: 'Previous Visit Length of Stay',
        value: visit.quantity,
        occurrence,
      })
      await executeAction(page, {
        type: 'selectOption',
        label: 'Previous Visit Length of Stay',
        value: visit.unit,
        occurrence,
      })
      changed = true
    }
    if (changed) log(`[prev_travel] Synchronized ${Math.min(visitsToFill.length, rowCount)} previous U.S. visit(s) from source`)
  }

  if (parsed.driverLicense === false) {
    const noLicense = page.locator('input[id$="rblPREV_US_DRIVER_LIC_IND_1"]').first()
    if (
      await noLicense.count() > 0 &&
      !await noLicense.isChecked().catch(() => false)
    ) {
      await noLicense.click()
      changed = true
    }
  }

  if (parsed.issuedVisa) {
    const visaInput = page.locator('input[id$="tbxPREV_VISA_FOIL_NUMBER"]').first()
    await visaInput.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {})
    if (await visaInput.count() === 0) {
      throw new Error(
        'Previous U.S. visa fields did not appear after answering Yes. The Yes radio likely needs an ASP.NET postback.',
      )
    }
    if (parsed.visaDate) {
      const visaYear = page.locator('input[id$="tbxPREV_VISA_ISSUED_DTEYear"]').first()
      const currentYear = await visaYear.inputValue().catch(() => '')
      const expectedYear = parsed.visaDate.split('/')[2]
      if (currentYear.trim() !== expectedYear) {
        await executeAction(page, {
          type: 'fill',
          label: 'Date Last Visa Was Issued',
          value: parsed.visaDate,
        })
        changed = true
      }
    }
    if (parsed.visaNumber && !/^n\/?a|do not know|does not apply$/i.test(parsed.visaNumber)) {
      const currentVisa = await visaInput.inputValue().catch(() => '')
      if (currentVisa.trim().toUpperCase() !== parsed.visaNumber.toUpperCase()) {
        await executeAction(page, {
          type: 'fill',
          label: 'Visa Number',
          value: parsed.visaNumber,
        })
        changed = true
      }
    }
    const followUps = [
      [parsed.sameType, 'rblPREV_VISA_SAME_TYPE_IND'],
      [parsed.sameCountry, 'rblPREV_VISA_SAME_CNTRY_IND'],
      [parsed.tenPrinted, 'rblPREV_VISA_TEN_PRINT_IND'],
      [parsed.lost, 'rblPREV_VISA_LOST_IND'],
      [parsed.cancelled, 'rblPREV_VISA_CANCELLED_IND'],
    ]
    for (const [answer, id] of followUps) {
      if (answer == null) continue
      if (await clickPrevTravelRadio(page, `${id}_0`, `${id}_1`, answer)) changed = true
    }
  }

  return changed
}

async function fillIfDifferent(input, value, { suppressAutofill = false } = {}) {
  const raw = String(value ?? '')
  if (!raw) return false
  const maxAttr = await input.getAttribute('maxlength').catch(() => null)
  const max = Number(maxAttr)
  const id = await input.getAttribute('id').catch(() => '')
  const next = Number.isFinite(max) && max > 0
    ? (/phone|tel/i.test(id || '')
      ? fitDs160Phone(raw, max)
      : fitDs160Value(raw, max, { city: /city/i.test(id || '') }))
    : raw
  const current = (await input.inputValue().catch(() => '')).trim()
  if (current.toUpperCase() === next.toUpperCase()) return false
  if (suppressAutofill) await suppressBrowserAutofill(input)
  await input.fill(next)
  return true
}

export async function syncUsStayAddressFromSource(page, sectionText) {
  const streetInput = page.locator('input[id$="tbxStreetAddress1"]').first()
  if (await streetInput.count() === 0) return false

  const parsed = parseUsStayAddressFromSource(sectionText)

  // This function writes to the inputs directly, so executeAction's marker guard
  // never sees these values. Drop them here instead: the DS-160 validates the
  // ZIP box and answers a literal "N/A" with "ZIP Code is invalid", which fails
  // the page and leaves the agent re-planning the same step until its budget is
  // gone. Blank is what "not applicable" looks like in these boxes.
  for (const part of ['street', 'city', 'state', 'zip']) {
    if (isMarkerValue(parsed[part])) parsed[part] = ''
  }

  if (!parsed.street && !parsed.city && !parsed.zip) return false

  let changed = false
  if (parsed.street && await fillIfDifferent(streetInput, parsed.street, { suppressAutofill: true })) {
    changed = true
  }
  if (parsed.city) {
    const city = page.locator('input[id$="tbxCity"]').first()
    if (await fillIfDifferent(city, parsed.city, { suppressAutofill: true })) changed = true
  }
  if (parsed.state) {
    const state = page.locator('select[id$="ddlTravelState"]').first()
    if (await state.count() > 0) {
      const current = await state.evaluate((el) => {
        const opt = el.options[el.selectedIndex]
        return opt ? `${opt.value} ${opt.text}`.toUpperCase() : ''
      }).catch(() => '')
      if (!current.includes(parsed.state)) {
        const picked = await state.evaluate((el, requested) => {
          const lo = requested.toLowerCase()
          const opt = Array.from(el.options).find((candidate) => {
            const text = candidate.text.trim().toLowerCase()
            const value = candidate.value.trim().toLowerCase()
            return value === lo || text === lo || text.startsWith(lo)
          })
          if (!opt) return false
          el.value = opt.value
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }, parsed.state).catch(() => false)
        if (picked) changed = true
      }
    }
  }
  if (parsed.zip) {
    const zip = page.locator('input[id$="tbZIPCode"]').first()
    if (await fillIfDifferent(zip, parsed.zip)) changed = true
  }
  if (changed) {
    log(`Synchronized U.S. stay address: ${parsed.street}, ${parsed.city}, ${parsed.state} ${parsed.zip}`)
  }
  return changed
}

export function parseIntendedStayFromSource(sectionText, answerSheet) {
  const raw = [
    sourceLineValue(sectionText, 'Intended Length of Stay in U.S.'),
    sourceLineValue(sectionText, 'Intended Length of Stay'),
    sourceLineValue(sectionText, 'Length of Stay'),
    answerSheet?.intended_length_of_stay,
  ].find((value) => String(value || '').trim()) || ''
  const text = String(raw).trim()
  if (!text) return null
  const qty = text.match(/\d+/)?.[0]
  if (!qty) return null
  const unit = Object.entries(STAY_UNIT_FROM_WORD).find(
    ([word]) => new RegExp(`\\b${word}\\b`, 'i').test(text),
  )?.[1]
  if (!unit) return null
  return { quantity: qty, unit }
}

export async function syncIntendedStayFromSource(page, sectionText, answerSheet) {
  const input = page.locator('input[id$="tbxTRAVEL_LOS"]').first()
  const select = page.locator('select[id$="ddlTRAVEL_LOS_CD"]').first()
  if (await input.count() === 0 || await select.count() === 0) return false
  if (!await input.isVisible().catch(() => false)) return false

  const parsed = parseIntendedStayFromSource(sectionText, answerSheet)
  if (!parsed) return false

  let changed = false
  const currentQty = (await input.inputValue().catch(() => '')).trim()
  if (currentQty !== parsed.quantity) {
    await input.fill(parsed.quantity)
    changed = true
  }

  const currentUnit = await select.evaluate((el) => (
    el.options[el.selectedIndex]?.text?.trim() || ''
  )).catch(() => '')
  const unitStem = parsed.unit.toLowerCase().replace(/\(s\)$/, '')
  if (!currentUnit.toLowerCase().includes(unitStem)) {
    const picked = await select.evaluate((el, requested) => {
      const lo = requested.toLowerCase()
      const opt = Array.from(el.options).find((candidate) => candidate.text.trim().toLowerCase() === lo)
      if (!opt) return false
      el.value = opt.value
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, parsed.unit).catch(() => false)
    if (picked) changed = true
  }

  if (changed) log(`Synchronized intended length of stay: ${parsed.quantity} ${parsed.unit}`)
  return changed
}

export async function syncSocialMediaFromSource(page, sectionText) {
  const selects = page.locator('select[id*="dtlSocial"][id*="ddlSocialMedia"]')
  if (await selects.count() === 0) return false

  const accounts = parseSocialMediaFromSource(sectionText)
  if (!accounts.length) {
    if (sourceUsedSocialMedia(sectionText) === true) return false
    const select = selects.first()
    const currentPlatform = await select.evaluate((el) => {
      const opt = el.options[el.selectedIndex]
      return opt ? opt.text.trim().toUpperCase() : ''
    }).catch(() => '')
    if (currentPlatform === 'NONE') return false
    await executeAction(page, {
      type: 'selectOption',
      label: 'Social Media Provider/Platform',
      value: 'NONE',
      occurrence: 1,
    })
    log('Synchronized social media: NONE (no accounts in source)')
    return true
  }

  let changed = false
  while (await selects.count() < accounts.length) {
    const before = await selects.count()
    await executeAction(page, { type: 'click', text: 'Add Another Social Media' })
    if (await selects.count() <= before) {
      logWarn('[social] Add Another did not create a new social-media row')
      break
    }
    changed = true
  }

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]
    const occurrence = i + 1
    const select = selects.nth(i)
    const currentPlatform = await select.evaluate((el) => {
      const opt = el.options[el.selectedIndex]
      return opt ? opt.text.trim().toUpperCase() : ''
    }).catch(() => '')
    if (currentPlatform !== account.platform.toUpperCase()) {
      await executeAction(page, {
        type: 'selectOption',
        label: 'Social Media Provider/Platform',
        value: account.platform,
        occurrence,
      })
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(300)
      changed = true
    }

    const ident = page.locator('input[id*="dtlSocial"][id*="tbxSocialMediaIdent"]').nth(i)
    const currentIdent = await ident.inputValue().catch(() => '')
    if (currentIdent.trim().toLowerCase() !== account.identifier.toLowerCase()) {
      await executeAction(page, {
        type: 'fill',
        label: 'Social Media Identifier',
        value: account.identifier,
        occurrence,
      })
      changed = true
    }
  }

  if (changed) log(`Synchronized ${accounts.length} social-media account(s) from source`)
  return changed
}

export function parsePreviousEmployerCitiesFromSource(sectionText, answerSheet) {
  const cities = []
  for (const line of String(sectionText || '').split('\n')) {
    const match = line.trim().match(/^Employer City:\s*(.+)$/i)
    if (match) cities.push(match[1].trim())
  }
  const fromProse = cities.filter((city) => city && !isMarkerValue(city))
  if (fromProse.length) return fromProse
  const rows = answerSheet?.previous_employers || answerSheet?.employers || []
  return rows
    .map((row) => String(row?.employer_city || '').trim())
    .filter((city) => city && !isMarkerValue(city))
}

export function parseEducationCitiesFromSource(sectionText, answerSheet) {
  const rows = answerSheet?.educational_institutions || answerSheet?.schools || []
  const fromSheet = rows
    .map((row) => String(row?.city || row?.school_city || '').trim())
    .filter((city) => city && !isMarkerValue(city))
  if (fromSheet.length) return fromSheet
  const cities = []
  for (const line of String(sectionText || '').split('\n')) {
    const match = line.trim().match(/^City:\s*(.+)$/i)
    if (match) cities.push(match[1].trim())
  }
  return cities.filter((city) => city && !isMarkerValue(city))
}

export async function syncWorkPreviousCitiesFromSource(page, sectionText, answerSheet) {
  const employerCities = parsePreviousEmployerCitiesFromSource(sectionText, answerSheet)
  const schoolCities = parseEducationCitiesFromSource(sectionText, answerSheet)
  workPreviousCitySource.employer = employerCities
  workPreviousCitySource.school = schoolCities

  let changed = false
  const empInputs = page.locator('input[id*="tbxEmpCity"], input[id$="tbxEmpCity"]')
  for (let i = 0; i < employerCities.length; i++) {
    if (await empInputs.count() <= i) break
    const input = empInputs.nth(i)
    const current = await input.inputValue().catch(() => '')
    if (sameCi(current, employerCities[i])) continue
    await fillLocatedInput(input, employerCities[i])
    log(`[work_previous] Employer city ${i + 1} → "${employerCities[i]}"`)
    changed = true
  }

  const schoolInputs = page.locator('input[id*="dtlPrevEduc"][id*="tbxSchoolCity"]')
  for (let i = 0; i < schoolCities.length; i++) {
    if (await schoolInputs.count() <= i) break
    const input = schoolInputs.nth(i)
    const current = await input.inputValue().catch(() => '')
    if (sameCi(current, schoolCities[i])) continue
    await fillLocatedInput(input, schoolCities[i])
    log(`[work_previous] Education city ${i + 1} → "${schoolCities[i]}"`)
    changed = true
  }
  return changed
}

export const JVISA_PREPARER = {
  organization: 'JVISA',
  street: '27 HERMON STREET',
  city: 'NAHARIYA',
  postal: '2220527',
  country: 'ISRAEL',
  relationship: 'CLERK',
}

const PREP_COUNTRY_SELECTORS = [
  '#ctl00_SiteContentPlaceHolder_FormView3_ddlCountry',
  'select[id*="FormView3"][id$="ddlCountry"]',
  'select[id*="FormView3"][id*="CNTRY" i]',
  'select[id*="PREP"][id*="CNTRY" i]',
  'select[id*="PREP"][id*="COUNTRY" i]',
  'select[id$="ddlPREP_CNTRY"]',
]

async function locatePreparerCountrySelect(page) {
  for (const sel of PREP_COUNTRY_SELECTORS) {
    const el = page.locator(sel).first()
    if ((await el.count().catch(() => 0)) === 0) continue
    if (await el.isVisible().catch(() => false)) return el
  }
  const byLabel = page
    .locator('#ctl00_SiteContentPlaceHolder_FormView3, [id*="FormView3"]')
    .locator('tr')
    .filter({ hasText: /Country\/Region/i })
    .locator('select')
    .first()
  if ((await byLabel.count().catch(() => 0)) > 0 && await byLabel.isVisible().catch(() => false)) {
    return byLabel
  }
  return null
}

export async function selectPreparerCountryIsrael(page) {
  const country = await locatePreparerCountrySelect(page)
  if (country) {
    const current = await country.evaluate((el) => el.options[el.selectedIndex]?.text?.trim() || '').catch(() => '')
    if (/israel/i.test(current)) return false
    const picked = await country.evaluate((el, val) => {
      const opt = Array.from(el.options).find((o) => {
        const text = o.text.trim().toUpperCase()
        return text === val || text.startsWith(`${val} `) || text.includes(val)
      })
      if (!opt) return false
      el.value = opt.value
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, JVISA_PREPARER.country)
    if (picked) log('[preparer] Country → "ISRAEL"')
    return Boolean(picked)
  }

  const input = page.locator(
    'input[id*="PREP"][id*="CNTRY"], input[id*="PREP"][id*="COUNTRY"], input[id$="tbxPREP_CNTRY"]',
  ).first()
  if ((await input.count().catch(() => 0)) === 0) return false
  const current = (await input.inputValue().catch(() => '')).trim()
  if (/israel/i.test(current)) return false
  await fillLocatedInput(input, JVISA_PREPARER.country)
  log('[preparer] Country → "ISRAEL"')
  return true
}

export function missingSignSubmitFields(prerequisites = {}) {
  const missing = []
  if (!prerequisites.jvisaAssistance) missing.push('assistance Yes')
  if (!/jvisa/i.test(String(prerequisites.organization || ''))) missing.push('organization')
  if (
    !prerequisites.relationship ||
    /^(select one|--|please select)$/i.test(String(prerequisites.relationship).trim())
  ) {
    missing.push('relationship')
  }
  if (!String(prerequisites.passport || '').trim()) missing.push('passport number')
  if (!String(prerequisites.captcha || '').trim()) missing.push('CAPTCHA')
  if (prerequisites.countryControlPresent && !/israel/i.test(String(prerequisites.country || ''))) {
    missing.push('country')
  }
  return missing
}

export async function readSignSubmitPrerequisites(page) {
  const yesAssistance = page.locator(
    '#ctl00_SiteContentPlaceHolder_FormView3_rblPREP_IND_0, input[id$="rblPREP_IND_0"]',
  ).first()
  const orgInput = page.locator(
    'input[id*="PREP"][id*="ORGANIZATION"], input[id$="tbxPREP_ORGANIZATION"]',
  ).first()
  const passportInput = page.locator('#ctl00_SiteContentPlaceHolder_PPTNumTbx').first()
  const captchaInput = page.locator('#ctl00_SiteContentPlaceHolder_CodeTextBox').first()
  const relationshipEl = page.locator(
    'select[id*="PREP"][id*="REL"], select[id$="ddlPREP_REL"], ' +
    'input[id*="PREP"][id*="REL"]:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), ' +
    'input[id$="tbxPREP_REL"]',
  ).first()

  const relationship = await relationshipEl.evaluate((el) => {
    if (!el) return ''
    if (el.tagName === 'SELECT') return String(el.options[el.selectedIndex]?.text || '').trim()
    return String(el.value || '').trim()
  }).catch(() => '')

  const countryEl = await locatePreparerCountrySelect(page)
  const country = countryEl
    ? await countryEl.evaluate((el) => el.options[el.selectedIndex]?.text?.trim() || '').catch(() => '')
    : ''

  return {
    jvisaAssistance: await yesAssistance.isChecked().catch(() => false),
    organization: (await orgInput.inputValue().catch(() => '')).trim(),
    relationship,
    country,
    countryControlPresent: Boolean(countryEl),
    passport: (await passportInput.inputValue().catch(() => '')).trim(),
    captcha: (await captchaInput.inputValue().catch(() => '')).trim(),
  }
}

function passportNumberFromApplicant(translatedText, answerSheet) {
  const fromSheet = answerSheet?.passport?.passport_number
  if (fromSheet && !isMarkerValue(fromSheet)) return String(fromSheet).trim()
  return String(translatedText || '').match(/Passport Number:\s*([A-Za-z0-9]+)/i)?.[1]?.trim() || ''
}

export async function syncJvisaPreparer(page) {
  const yes = page.locator(
    '#ctl00_SiteContentPlaceHolder_FormView3_rblPREP_IND_0, input[id$="rblPREP_IND_0"]',
  ).first()
  if (await yes.count() === 0) return false

  let changed = false
  if (!await yes.isChecked().catch(() => false)) {
    await yes.scrollIntoViewIfNeeded().catch(() => {})
    await yes.click()
    log('[preparer] Selected Yes — JVisa assisted with this application')
    await page.locator(
      'input[id*="PREP"][id*="ORGANIZATION"], input[id$="tbxPREP_ORGANIZATION"]',
    ).first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
      logWarn('[preparer] Organization field did not appear after Yes')
    })
    return true
  }

  const nameNa = page.locator(
    'input[type="checkbox"][id*="PREP"][id*="NAME"][id*="NA"], input[type="checkbox"][id*="PREP_NAME"]',
  ).first()
  if (await nameNa.count() > 0 && !await nameNa.isChecked().catch(() => false)) {
    await nameNa.click()
    if (await nameNa.isChecked().catch(() => false)) changed = true
  }

  const stateNa = page.locator(
    'input[type="checkbox"][id*="PREP"][id*="STATE"][id*="NA"]',
  ).first()
  if (await stateNa.count() > 0 && !await stateNa.isChecked().catch(() => false)) {
    await stateNa.click()
    if (await stateNa.isChecked().catch(() => false)) changed = true
  }

  const fills = [
    ['input[id*="PREP"][id*="ORGANIZATION"], input[id$="tbxPREP_ORGANIZATION"]', JVISA_PREPARER.organization],
    ['input[id*="PREP"][id*="ADDR"], input[id$="tbxPREP_ADDR_LN1"]', JVISA_PREPARER.street],
    ['input[id*="PREP"][id*="CITY"], input[id$="tbxPREP_CITY"]', JVISA_PREPARER.city],
    ['input[id*="PREP"][id*="POSTAL"], input[id$="tbxPREP_POSTAL_CD"]', JVISA_PREPARER.postal],
  ]
  for (const [selector, value] of fills) {
    const input = page.locator(selector).first()
    if (await input.count() === 0) continue
    const current = await input.inputValue().catch(() => '')
    if (sameCi(current, value)) continue
    await fillLocatedInput(input, value)
    changed = true
  }

  if (await selectPreparerCountryIsrael(page)) changed = true

  const relationship = page.locator(
    'select[id*="PREP"][id*="REL"], select[id$="ddlPREP_REL"], ' +
    'input[id*="PREP"][id*="REL"]:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), ' +
    'input[id$="tbxPREP_REL"]',
  ).first()
  if (await relationship.count() > 0) {
    const tag = await relationship.evaluate((el) => el.tagName).catch(() => '')
    if (tag === 'SELECT') {
      const current = await relationship.evaluate((el) => el.options[el.selectedIndex]?.text?.trim() || '').catch(() => '')
      if (!sameCi(current, JVISA_PREPARER.relationship) && !/clerk|other/i.test(current)) {
        await relationship.evaluate((el, val) => {
          const opts = Array.from(el.options)
          const opt =
            opts.find((o) => o.text.toUpperCase().includes(val.toUpperCase())) ||
            opts.find((o) => /other/i.test(o.text))
          if (!opt) return
          el.value = opt.value
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }, JVISA_PREPARER.relationship)
        changed = true
      }
    } else {
      const current = await relationship.inputValue().catch(() => '')
      if (!sameCi(current, JVISA_PREPARER.relationship)) {
        await fillLocatedInput(relationship, JVISA_PREPARER.relationship)
        changed = true
      }
    }
  }

  if (changed) log('[preparer] Synchronized JVisa preparer details')
  return changed
}

export async function syncSignSubmitPage(page, translatedText, answerSheet) {
  let changed = await syncJvisaPreparer(page)
  const ppt = passportNumberFromApplicant(translatedText, answerSheet)
  const passportInput = page.locator('#ctl00_SiteContentPlaceHolder_PPTNumTbx').first()
  if (ppt && await passportInput.count() > 0) {
    const current = (await passportInput.inputValue().catch(() => '')).trim()
    if (current !== ppt) {
      await passportInput.fill(ppt)
      log(`[preparer] Passport number → "${ppt}"`)
      changed = true
    }
  }
  return changed
}

// ─── work_additional deterministic helpers ────────────────────────────────────

/**
 * Parse all "Languages Spoken: <lang>" lines from the ADDITIONAL BACKGROUND section.
 */
export function parseLanguagesFromSource(sectionText, answerSheet) {
  const langs = []
  for (const line of String(sectionText || '').split('\n')) {
    const m = line.trim().match(/^Languages Spoken:\s*(.+)$/i)
    if (m) langs.push(m[1].trim())
  }
  const fromProse = langs.filter((lang) => lang && !isMarkerValue(lang))
  if (fromProse.length) return fromProse
  if (Array.isArray(answerSheet?.languages)) {
    return answerSheet.languages
      .map((lang) => String(lang || '').trim())
      .filter((lang) => lang && !isMarkerValue(lang))
  }
  return []
}

/**
 * Parse all "Countries Visited in the Last 5 Years: <country>" lines.
 */
export function parseCountriesVisitedFromSource(sectionText, answerSheet) {
  const countries = []
  for (const line of String(sectionText || '').split('\n')) {
    const m = line.trim().match(/^Countries Visited in the Last 5 Years:\s*(.+)$/i)
    if (m) countries.push(m[1].trim())
  }
  const fromProse = countries.filter((country) => country && !isMarkerValue(country))
  if (fromProse.length) return fromProse
  if (Array.isArray(answerSheet?.countries_visited_last_five_years)) {
    return answerSheet.countries_visited_last_five_years
      .map((country) => String(country || '').trim())
      .filter((country) => country && !isMarkerValue(country))
  }
  return []
}

/**
 * Deterministically fill all languages from source on the work_additional page.
 * Returns true if any change was made.
 */
export async function syncLanguagesFromSource(page, sectionText, answerSheet) {
  const langInputs = page.locator('input[id*="dtlLANGUAGES"][id*="tbxLANGUAGE_NAME"]')
  if (await langInputs.count() === 0) return false

  const langs = parseLanguagesFromSource(sectionText, answerSheet)
  if (!langs.length) return false

  let changed = false
  while (await langInputs.count() < langs.length) {
    const before = await langInputs.count()
    const last = langInputs.nth(before - 1)
    const expected = langs[before - 1]
    const current = await last.inputValue().catch(() => '')
    if (expected && !sameCi(current, expected)) {
      await fillLocatedInput(last, expected)
    } else {
      await commitControl(last)
    }
    try {
      await executeAction(page, { type: 'click', text: 'Add Another Language' })
    } catch (err) {
      logWarn(`[languages] Could not add row ${before + 1}: ${err.message}`)
      break
    }
    if (await langInputs.count() <= before) {
      logWarn('[languages] Add Another did not create a new language row')
      break
    }
    changed = true
  }

  for (let i = 0; i < langs.length; i++) {
    if (await langInputs.count() <= i) break
    const input = langInputs.nth(i)
    const current = await input.inputValue().catch(() => '')
    if (sameCi(current, langs[i])) {
      log(`[languages] Row ${i + 1} already set to "${langs[i]}"`)
      continue
    }
    await fillLocatedInput(input, langs[i])
    log(`[languages] Filled row ${i + 1} with "${langs[i]}"`)
    changed = true
  }
  if (changed) log(`Synchronized ${Math.min(langs.length, await langInputs.count())} language(s) from source`)
  return changed
}

/**
 * Deterministically fill all visited countries from source on the work_additional page.
 * Returns true if any change was made.
 */
export async function syncCountriesVisitedFromSource(page, sectionText, answerSheet) {
  const countries = parseCountriesVisitedFromSource(sectionText, answerSheet)
  if (!countries.length) return false

  let changed = false
  const yesRadio = page.locator('input[id$="rblCOUNTRIES_VISITED_IND_0"]')
  if (await yesRadio.count() > 0 && !(await yesRadio.isChecked().catch(() => false))) {
    await yesRadio.scrollIntoViewIfNeeded().catch(() => {})
    await yesRadio.click()
    log('[countries] Selected Yes for countries visited in the last five years')
    changed = true
  }

  const countrySelects = page.locator('select[id*="dtlCountriesVisited"][id*="ddlCOUNTRIES_VISITED"]')
  const dropdownReady = await countrySelects.first()
    .waitFor({ state: 'attached', timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (!dropdownReady) return changed

  while (await countrySelects.count() < countries.length) {
    const before = await countrySelects.count()
    const last = countrySelects.nth(before - 1)
    await commitControl(last)
    try {
      await executeAction(page, { type: 'click', text: 'Add Another Visited Country' })
    } catch (err) {
      logWarn(`[countries] Could not add row ${before + 1}: ${err.message}`)
      break
    }
    if (await countrySelects.count() <= before) {
      logWarn('[countries] Add Another did not create a new country row')
      break
    }
    changed = true
  }

  for (let i = 0; i < countries.length; i++) {
    if (await countrySelects.count() <= i) break
    const country = countries[i]
    const sel = countrySelects.nth(i)
    const current = await sel.evaluate((el) => el.options[el.selectedIndex]?.text?.trim() || '').catch(() => '')

    const wouldSelect = await sel.evaluate((el, val) => {
      const opts = Array.from(el.options)
      const exact = opts.find((o) => o.text.toUpperCase() === val.toUpperCase())
      const partial = opts.find((o) => o.text.toUpperCase().startsWith(val.toUpperCase()))
      return (exact || partial)?.text?.trim() || null
    }, country)

    if (wouldSelect && sameCi(wouldSelect, current)) {
      log(`[countries] Row ${i + 1} already set to "${current}"`)
      continue
    }
    if (wouldSelect) {
      await sel.evaluate((el, val) => {
        const opts = Array.from(el.options)
        const match = opts.find((o) => o.text.toUpperCase() === val.toUpperCase())
        if (match) {
          el.value = match.value
          el.dispatchEvent(new Event('change', { bubbles: true }))
          if (typeof window.setDirty === 'function') {
            try { window.setDirty() } catch { /* ignore */ }
          }
        }
      }, wouldSelect)
      log(`[countries] Selected "${wouldSelect}" in row ${i + 1}`)
      changed = true
    } else {
      log(`[countries] ⚠️ Could not find option for "${country}" in row ${i + 1}`)
    }
  }

  const expectedCount = countries.length
  let currentCount = await countrySelects.count()
  while (currentCount > expectedCount) {
    const removeLinks = page.locator('a[id*="dtlCountriesVisited"][id*="DeleteButtonCountriesVisited"]')
    const rmCount = await removeLinks.count()
    if (rmCount > 0) {
      const removedVal = await countrySelects.nth(currentCount - 1)
        .evaluate((el) => el.options[el.selectedIndex]?.text?.trim() || '').catch(() => '')
      await clickAspNetPostBackLink(removeLinks.nth(rmCount - 1))
      await page.waitForTimeout(600)
      log(`[countries] Removed extra row ${currentCount} ("${removedVal}")`)
      changed = true
    } else {
      break
    }
    currentCount = await countrySelects.count()
  }

  return changed
}

export function parseTravelCompanions(sectionText) {
  const companions = []
  let current = null
  for (const rawLine of String(sectionText || '').split('\n')) {
    const line = rawLine.trim()
    let match = line.match(/^Surnames of Person Traveling With You:\s*(.+)$/i)
    if (match) {
      if (current?.surname) companions.push(current)
      current = { surname: match[1].trim(), givenName: '', relationship: '' }
      continue
    }
    match = line.match(/^Given Names of Person Traveling With You:\s*(.+)$/i)
    if (match && current) {
      current.givenName = match[1].trim()
      continue
    }
    match = line.match(/^Relationship:\s*(.+)$/i)
    if (match && current) {
      current.relationship = match[1].trim()
      companions.push(current)
      current = null
    }
  }
  if (current?.surname) companions.push(current)
  // A row is only usable if all three parts are real answers. Dropping marker
  // values here keeps them out of syncTravelCompanionsFromSource, which writes
  // to the inputs directly and so never reaches executeAction's guard.
  return companions.filter((companion) =>
    !isMarkerValue(companion.surname) &&
    !isMarkerValue(companion.givenName) &&
    !isMarkerValue(companion.relationship))
}

function companionRelationshipValue(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (/spouse|husband|wife/.test(normalized)) return 'SPOUSE'
  if (/child|son|daughter/.test(normalized)) return 'CHILD'
  if (/parent|mother|father/.test(normalized)) return 'PARENT'
  if (/friend/.test(normalized)) return 'FRIEND'
  if (/relative|sibling|brother|sister/.test(normalized)) return 'OTHER RELATIVE'
  return 'OTHER'
}

function companionControls(page) {
  return {
    surnames: page
      .locator('input[id*="TravelCompan" i][id*="Surname" i]')
      .or(page.getByLabel(/Surnames of Person Traveling With You/i)),
    givenNames: page
      .locator('input[id*="TravelCompan" i][id*="Given" i]')
      .or(page.getByLabel(/Given Names of Person Traveling With You/i)),
    relationships: page
      .locator('select[id*="TravelCompan" i][id*="Relation" i], select[id*="TravelCompan" i][id*="ddlTCRelationship" i]')
      .or(page.getByLabel(/Relationship with Person/i)),
  }
}

export async function syncTravelCompanionsFromSource(page, sectionText) {
  const companions = parseTravelCompanions(sectionText)
  if (!companions.length) return false

  const controls = companionControls(page)
  if (await controls.surnames.count() === 0) return false
  let changed = false

  while (await controls.surnames.count() < companions.length) {
    const previousCount = await controls.surnames.count()
    const addLinks = page.locator(
      'a[id*="TravelCompan" i][id*="InsertButton" i], a[title="Add Another"]',
    )
    const linkCount = await addLinks.count()
    if (!linkCount) throw new Error('Travel-companion "Add Another" link was not found')
    await clickAspNetPostBackLink(addLinks.nth(linkCount - 1))
    await controls.surnames.nth(previousCount).waitFor({ state: 'attached', timeout: 10_000 })
    log(`Added travel companion row ${previousCount + 1}`)
    changed = true
  }

  for (let index = 0; index < companions.length; index += 1) {
    const companion = companions[index]
    const surname = controls.surnames.nth(index)
    const givenName = controls.givenNames.nth(index)
    const relationship = controls.relationships.nth(index)
    if (
      !await surname.isVisible().catch(() => false) ||
      !await givenName.isVisible().catch(() => false) ||
      !await relationship.isVisible().catch(() => false)
    ) {
      throw new Error(`Travel companion row ${index + 1} is incomplete in the CEAC DOM`)
    }

    if ((await surname.inputValue()).trim().toUpperCase() !== companion.surname.toUpperCase()) {
      await surname.fill(companion.surname)
      changed = true
    }
    if ((await givenName.inputValue()).trim().toUpperCase() !== companion.givenName.toUpperCase()) {
      await givenName.fill(companion.givenName)
      changed = true
    }

    const requestedRelationship = companionRelationshipValue(companion.relationship)
    // Use the option's visible text (not the value attribute) for comparison so
    // the "already selected" check fires correctly after a successful selectOption.
    const currentRelationship = await relationship.evaluate((el) => {
      const opt = el.options[el.selectedIndex]
      return opt ? opt.text.trim().toUpperCase() : ''
    }).catch(() => '')
    if (currentRelationship !== requestedRelationship) {
      let selected = false
      try {
        await relationship.selectOption({ value: requestedRelationship })
        selected = true
      } catch {
        try {
          await relationship.selectOption({ label: requestedRelationship })
          selected = true
        } catch { /* handled below */ }
      }
      if (!selected) {
        throw new Error(
          `Could not select relationship "${requestedRelationship}" for travel companion row ${index + 1}`,
        )
      }
      await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {})
      changed = true
    }
  }

  if (changed) log(`Synchronized all ${companions.length} travel companions from source data`)
  return changed
}

function securitySectionIsAllNo(sectionText) {
  const values = String(sectionText || '')
    .split('\n')
    .map((line) => line.match(/:\s*(.*?)\s*$/)?.[1]?.trim())
    .filter(Boolean)

  return values.length > 0 && values.every((value) => /^no$/i.test(value))
}

async function selectAllVisibleSecurityNo(page) {
  const noRadios = await page.locator(
    'input[type="radio"][id*="_FormView1_rbl"][id$="_1"]',
  ).all()
  let selected = 0

  for (const radio of noRadios) {
    if (!await radio.isVisible().catch(() => false)) continue
    if (await radio.isChecked().catch(() => false)) continue
    await radio.scrollIntoViewIfNeeded().catch(() => {})
    await radio.click()
    selected++
  }

  return selected
}

// ─── Main agent loop ─────────────────────────────────────────────────────────

import { extractPageInventory, diffInventory, findUnplannedRequired } from './page-inventory.js'
import { planPage } from './plan-page.js'
import { matchPage, MATCHER_PAGES, revealedFieldsToFill, isIntendedStayLengthField } from './match-page.js'
import { controlName, isMarkerValue } from './ds160-fields.js'
import { nextAdvanceAction, queueWithAdvance, shouldForceNextAfterIdle, stripDoneActions } from './done-advance.js'

const MAX_STEPS = 500
const MAX_CONSECUTIVE_ERRORS = 5
// How often "done" is refused while the page still shows validation errors.
// Bounded because a genuinely unfillable required field must not loop forever.
const MAX_DONE_REJECTIONS = 3
// Maximum planner LLM calls per page before falling back to the vision agent
const MAX_LLM_CALLS_PER_PAGE = 4
// Pages where the batch planner is used; others fall back to the vision agent
const PLANNER_PAGES = new Set([
  'personal1','personal2','travel','companions','prev_travel','address',
  'passport','contact','family','spouse','work_present','work_previous',
  'work_additional','work_edu','security',
])
// Per-page stall limits — longer for dense sections like Travel and Security
const PAGE_STALL_LIMITS = {
  travel:           60,
  security:         60,
  photo:            20,
  work_present:     35,
  work_previous:    60,
  work_additional:  70,
  work_edu:         50,
  family:           50,
  spouse:           35,
  address:          40,
  personal1:        35,
  personal2:        35,
  prev_travel:      70,
  passport:         35,
  contact:          30,
  companions:       40,
  security_question:20,
  captcha:          15,
  disclaimer:       10,
  review:           20,
  sign_submit:      40,
  unknown:          40,
}

function accumUsage(total, usage) {
  if (!usage) return
  total.prompt_tokens     += usage.prompt_tokens     || 0
  total.completion_tokens += usage.completion_tokens || 0
  total.cached_tokens     += usage.prompt_tokens_details?.cached_tokens || 0
  total.total_tokens      += usage.total_tokens      || 0
}

/**
 * Execute a solveCaptcha action (shared between planner and vision loops).
 */
async function executeCaptchaAction(page, apiKey, pageContext, actionHistory, logDeferredSummary) {
  if (await pageLooksLikeCloudflareChallenge(page)) {
    await waitForHumanBotVerification(page)
    actionHistory.push({ type: 'wait', reason: 'cloudflare_turnstile' })
    return { submitted: false }
  }

  let captchaText = ''
  let captchaSuccess = false
  const tries = pageContext === 'sign_submit' ? 12 : 8

  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      if (attempt > 1) await reloadCaptchaImage(page)
      captchaText = await solveCaptchaOnPage(page, apiKey)
      if (!captchaText) throw new Error('CAPTCHA OCR returned empty text')
      const captchaInputSelectors = [
        '#ctl00_SiteContentPlaceHolder_CodeTextBox',
        '#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha',
        '#ctl00_SiteContentPlaceHolder_ucAppSecurityQuestion_txtcaptcha',
        'input[type="text"][id$="CodeTextBox"]',
        'input[type="text"][id*="txtcaptcha" i]',
        'input[type="text"][id*="captcha" i]',
      ]
      let filled = false
      for (const sel of captchaInputSelectors) {
        try {
          const el = page.locator(sel).first()
          await el.waitFor({ state: 'visible', timeout: 2000 })
          await el.fill(captchaText)
          filled = true
          break
        } catch { /* try next */ }
      }
      if (!filled) throw new Error('Could not find CAPTCHA input field')
      if (pageContext === 'sign_submit') {
        await executeAction(page, { type: 'submitApplication' })
        await page.waitForTimeout(2000)
        const stillSign = await page.locator('#ctl00_SiteContentPlaceHolder_btnSignApp').isVisible().catch(() => false)
        const signed = /successfully signed and submitted/i.test(
          await page.locator('body').innerText().catch(() => ''),
        )
        if (!signed && stillSign) throw new Error('Still on Sign page after submit')
        actionHistory.push({ type: 'solveCaptcha', answer: captchaText })
        actionHistory.push({ type: 'submitApplication' })
        log(`Application submission succeeded on CAPTCHA attempt ${attempt}/${tries}`)
        logDeferredSummary()
        return { submitted: true }
      }
      captchaSuccess = true
      break
    } catch (err) {
      logWarn(`CAPTCHA attempt ${attempt}/${tries} failed: ${err.message}`)
      await page.waitForTimeout(1000)
    }
  }

  if (!captchaSuccess) {
    logError(`All ${tries} CAPTCHA attempts failed`)
  }

  actionHistory.push({ type: 'solveCaptcha', answer: captchaText })
  await page.waitForTimeout(500)
  return { submitted: false }
}

/**
 * Run the agent loop until it signals done (or reaches step limit).
 *
 * Uses a batch planner for form-fill pages (one text-only LLM call per page
 * state, no screenshot). Falls back to the vision agent for CAPTCHA, review,
 * photo, and unknown pages, and whenever the planner fails.
 *
 * @param {import('playwright').Page} page
 * @param {string} translatedText
 * @param {string} apiKey
 * @param {{ answerSheet?: object }} [opts]
 * @returns {Promise<{ outcome: 'submitted' | 'blocked' }>}
 */
export async function runAgent(page, translatedText, apiKey, opts = {}) {
  await disarmCeacUnload(page)
  const { answerSheet } = opts
  let personal1SavedNotified = false

  // Return the best available answers for a page context: structured JSON section
  // from the answerSheet (compact, reliable) or prose fallback from filterTranslatedText.
  const getAnswersForPage = (ctx, relevantText) => {
    if (answerSheet) {
      const section = answerSheet[ctx]
      if (section && typeof section === 'object') {
        return JSON.stringify(section, null, 2)
      }
    }
    return relevantText
  }
  const actionHistory = []
  const deferredIssues = []
  const failedActionCounts = new Map()
  let consecutiveErrors = 0
  // How many times "done" may be refused because the page still reports errors,
  // before the run is allowed to end for review anyway.
  let doneRejections = 0
  let nativeAlphabetValue = ''
  // Stall detection
  let currentPageContext = 'unknown'
  let stepsOnCurrentPage = 0
  let lastValidationSignature = ''
  // Reset on a real fill or a page change. Sync loops that rewrite the same
  // value do not count — those are what left Travel sitting on the visa class.
  let lastProgressAt = Date.now()
  // Planner state — plan object (queue + inventory) can be nullified mid-page,
  // but call counts must survive nullification so the vision fallback kicks in.
  let currentPlan = null // { pageContext, queue: [...], inventory: {...} }
  const pagePlannerCalls = new Map() // pageContext → total planPage() calls so far
  // Cost tracking
  const runUsage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, total_tokens: 0 }
  const pageUsageLog = []

  const logDeferredSummary = () => {
    if (!deferredIssues.length) return
    logWarn(`⚠️ REVIEW REQUIRED: ${deferredIssues.length} item(s) were deferred during testing:`)
    deferredIssues.forEach((issue, index) => {
      logWarn(`  ${index + 1}. ${issue.fieldLabel} — ${issue.reason}`)
    })
  }

  const logRunCost = () => {
    log(`💰 Token usage — prompt: ${runUsage.prompt_tokens} (cached: ${runUsage.cached_tokens}), completion: ${runUsage.completion_tokens}, total: ${runUsage.total_tokens}`)
    if (pageUsageLog.length) {
      log('💰 Per-page breakdown:')
      for (const p of pageUsageLog) {
        log(`   ${p.page.padEnd(20)} calls=${p.calls} prompt=${p.prompt} completion=${p.completion}`)
      }
    }
  }

  log('Agent loop started (planner mode).')

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`Step ${step}/${MAX_STEPS}`)

    await throwIfCeacServiceUnavailable(page)

    // ── Session timeout detection ─────────────────────────────────────────────
    // Throw so fill-ds160 can retrieve the captured Application ID and retry.
    try {
      const recoverBtn = page.locator('input[id="ctl00_btnRecover"]').first()
      if (await recoverBtn.isVisible({ timeout: 300 })) {
        logWarn('⏰ DS-160 session has timed out — the "Recover Application" modal is showing.')
        logDeferredSummary()
        logRunCost()
        throw new Error(
          '⏰ DS-160 session timed out. Autofill will retrieve the application and retry.',
        )
      }
    } catch (e) {
      if (e.message.includes('session timed out')) throw e
      // Any other error here (element not found, etc.) means the modal is not showing — continue normally
    }

    if (await waitForHumanBotVerification(page)) {
      currentPlan = null
      lastProgressAt = Date.now()
      continue
    }

    await dismissCeacLeavePageDialog(page)

    await detectAndLogSection(page)

    // ── Page context + stall detection ──────────────────────────────────────
    const pageContext = await detectCurrentPageContext(page)
    if (pageContext === currentPageContext) {
      stepsOnCurrentPage++
    } else {
      if (currentPageContext !== 'unknown') {
        log(`📄 Page changed: "${currentPageContext}" → "${pageContext}" (after ${stepsOnCurrentPage} steps)`)
      }
      // Page changed — discard the old plan (but keep pagePlannerCalls for the new page fresh)
      if (currentPlan && currentPlan.pageContext !== pageContext) {
        currentPlan = null
      }
      currentPageContext = pageContext
      stepsOnCurrentPage = 1
      lastValidationSignature = '' // reset so errors on new page are logged
      lastProgressAt = Date.now()
    }

    if (!personal1SavedNotified && pageIsAfterPersonal1(pageContext)) {
      personal1SavedNotified = true
      try { opts.onPersonal1Saved?.() } catch { /* persistence is best-effort */ }
    }

    if (pageContext === 'confirmation') {
      log('Confirmation page reached — application is signed. Handing off to PDF save.')
      logDeferredSummary()
      logRunCost()
      return { outcome: 'submitted' }
    }

    const stallLimit = PAGE_STALL_LIMITS[pageContext] ?? 40
    if (stepsOnCurrentPage > stallLimit) {
      logDeferredSummary()
      logRunCost()
      throw new Error(
        `⛔ Stall detected — stuck on page "${pageContext}" for ${stepsOnCurrentPage} consecutive steps ` +
        `(limit: ${stallLimit}). This usually means a CAPTCHA was not solved, a required field was missed, ` +
        `or a navigation button was not clicked. Aborting.`
      )
    }

    log(`[page: ${pageContext}, step-on-page: ${stepsOnCurrentPage}]`)

    if (shouldForceNextAfterIdle(Date.now() - lastProgressAt, pageContext)) {
      logWarn(
        `No progress for 15s on "${pageContext}" — clicking Next so CEAC can show a validation error`,
      )
      lastProgressAt = Date.now()
      currentPlan = null
      try {
        const inventory = await extractPageInventory(page)
        const advance = nextAdvanceAction({ inventory, pageContext })
        if (!advance) {
          logWarn(`No Next button on "${pageContext}" after the idle wait`)
        } else {
          await executeAction(page, advance)
          actionHistory.push({ type: '_idle_next', ...advance })
          await page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {})
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
        }
      } catch (err) {
        logWarn(`Idle Next click failed: ${err.message}`)
      }
      continue
    }

    const relevantText = filterTranslatedText(translatedText, pageContext)
    const prevTravelText = filterTranslatedText(translatedText, 'prev_travel')
    const travelText = filterTranslatedText(translatedText, 'travel')

    // ── Deterministic short-circuits (no LLM needed) ─────────────────────────
    // Run even if pageContext detection missed node=PreviousTravel.
    if (await syncPrevTravelFromSource(page, prevTravelText)) {
      actionHistory.push({ type: '_prev_travel_synced_from_source' })
      currentPlan = null
      await page.waitForTimeout(300)
      continue
    }

    if (await syncUsStayAddressFromSource(page, translatedText)) {
      actionHistory.push({ type: '_us_stay_address_synced_from_source' })
      currentPlan = null
      await page.waitForTimeout(200)
      continue
    }

    if (await syncPayerCompanyFromSource(page, travelText)) {
      actionHistory.push({ type: '_payer_company_synced_from_source' })
      currentPlan = null
      await page.waitForTimeout(200)
      continue
    }

    if (await syncIntendedStayFromSource(page, travelText, answerSheet?.travel)) {
      actionHistory.push({ type: '_intended_stay_synced_from_source' })
      currentPlan = null
      await page.waitForTimeout(200)
      continue
    }

    if (pageContext === 'address') {
      try {
        if (await syncSocialMediaFromSource(page, relevantText)) {
          actionHistory.push({ type: '_social_media_synced_from_source' })
          currentPlan = null
          await page.waitForTimeout(300)
          continue
        }
      } catch (err) {
        logWarn(`[social] Sync failed: ${err.message}`)
      }
    }

    if (pageContext === 'spouse' && await syncSpouseNameFromSource(page, relevantText)) {
      actionHistory.push({ type: '_spouse_name_synced_from_source' })
      await page.waitForTimeout(200)
      continue
    }

    if (pageContext === 'companions' && await syncTravelCompanionsFromSource(page, relevantText)) {
      actionHistory.push({
        type: '_travel_companions_synced_from_source',
        count: parseTravelCompanions(relevantText).length,
      })
      await page.waitForTimeout(300)
      continue
    }

    if (pageContext === 'security' && securitySectionIsAllNo(relevantText)) {
      const selected = await selectAllVisibleSecurityNo(page)
      if (selected > 0) {
        log(`Selected all ${selected} visible security answers as No`)
        actionHistory.push({ type: '_security_all_no', selected })
        await page.waitForTimeout(500)
        currentPlan = null // force fresh plan after the fast-fill
        continue
      }
    }

    if (pageContext === 'work_previous') {
      const prevSheet = answerSheet?.work_previous
      if (await syncWorkPreviousCitiesFromSource(page, relevantText, prevSheet)) {
        actionHistory.push({ type: '_work_previous_cities_synced_from_source' })
        currentPlan = null
        await page.waitForTimeout(200)
        continue
      }
    }

    if (pageContext === 'work_additional') {
      const extraSheet = answerSheet?.work_additional
      const langChanged = await syncLanguagesFromSource(page, relevantText, extraSheet)
      const cntryChanged = await syncCountriesVisitedFromSource(page, relevantText, extraSheet)
      if (langChanged || cntryChanged) {
        actionHistory.push({ type: '_work_additional_rows_synced_from_source' })
        currentPlan = null
        await page.waitForTimeout(300)
        continue
      }
    }

    if (pageContext === 'sign_submit') {
      const changed = await syncSignSubmitPage(page, translatedText, answerSheet)
      if (changed) {
        actionHistory.push({ type: '_sign_submit_synced' })
        await page.waitForTimeout(300)
        continue
      }
    }

    const validationErrors = await readVisibleValidationErrors(page)
    const validationSignature = validationErrors.join('\n')
    if (validationSignature && validationSignature !== lastValidationSignature) {
      logWarn(`Visible form validation: ${validationErrors.join(' | ')}`)
      // Validation errors invalidate the current plan
      if (currentPlan) {
        currentPlan = null
        log('[planner] Plan invalidated by new validation errors — will re-plan')
      }
    }
    lastValidationSignature = validationSignature

    // ── Decide next action ────────────────────────────────────────────────────
    let action

    // Landing page is not a matcher/planner page. If setup already filled
    // location + CAPTCHA, click Start by id instead of asking vision.
    if (pageContext === 'captcha') {
      const embassyText = await page
        .locator('#ctl00_SiteContentPlaceHolder_ucLocationSearch_ddlLocation, select[id$="ddlLocation"]')
        .first()
        .locator('option:checked')
        .textContent()
        .catch(() => '')
      if (!/tel aviv/i.test(embassyText || '')) {
        action = { type: 'selectEmbassy', value: 'Tel Aviv' }
      } else {
        const captchaVal = await page
          .locator('#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha, input[id*="captcha" i]')
          .first()
          .inputValue()
          .catch(() => '')
        action = String(captchaVal || '').trim()
          ? { type: 'click', text: 'START AN APPLICATION' }
          : { type: 'solveCaptcha' }
      }
      log(`[landing] ${action.type}${action.text ? ` "${action.text}"` : ''}`)
    }

    if (!action && pageContext === 'sign_submit') {
      const missing = missingSignSubmitFields(await readSignSubmitPrerequisites(page))
      if (missing.length === 0) {
        action = { type: 'submitApplication' }
      } else if (missing.length === 1 && missing[0] === 'CAPTCHA') {
        action = { type: 'solveCaptcha' }
      } else {
        logWarn(`Sign/submit still missing: ${missing.join(', ')}`)
        await page.waitForTimeout(800)
        continue
      }
      log(`[sign_submit] ${action.type}`)
    }

    if (!action && PLANNER_PAGES.has(pageContext)) {
      const plannerCallsForPage = pagePlannerCalls.get(pageContext) || 0
      const plannerBudgetExhausted = plannerCallsForPage >= MAX_LLM_CALLS_PER_PAGE

      // ── Build or reuse plan ───────────────────────────────────────────────
      const needNewPlan = !currentPlan ||
        currentPlan.pageContext !== pageContext ||
        currentPlan.queue.length === 0

      if (needNewPlan && !plannerBudgetExhausted) {
        let inventory
        try {
          inventory = await extractPageInventory(page)
        } catch (invErr) {
          logWarn(`[planner] Inventory extraction failed: ${invErr.message} — falling back to vision for this step`)
          inventory = null
        }

        if (inventory) {
          let planResult = null
          // Determine whether this is a fresh page plan or a delta (exhausted queue)
          const isExhaustedDelta = currentPlan?.pageContext === pageContext && currentPlan.queue.length === 0

          // ── Deterministic matcher — maps the inventory onto the applicant's
          //    answers with no LLM call. Validation-error recovery stays with the
          //    planner: deciding which field an error refers to needs its
          //    judgement, not a label match.
          let matcherActions = null
          let plannerFields = null
          let matcherOwnsPage = false
          if (MATCHER_PAGES.has(pageContext) && validationErrors.length === 0) {
            try {
              const matched = matchPage({
                pageContext,
                inventory,
                answers: relevantText,
                answerSheet: answerSheet?.[pageContext],
              })
              if (matched.unresolvedRequired.length === 0) {
                const queue = queueWithAdvance(matched.actions, matched.nextClick)
                if (queue.length) {
                  log(`[matcher] Planned page "${pageContext}" from applicant data — ${matched.actions.length} field action(s), no LLM call`)
                  currentPlan = { pageContext, queue, inventory }
                  matcherOwnsPage = true
                }
              } else if (matched.actions.length > 0) {
                // Fill what is unambiguous here and let the planner see only the rest.
                matcherActions = matched.actions
                plannerFields = matched.unresolvedRequired
                log(
                  `[matcher] Matched ${matched.actions.length} field(s) on "${pageContext}"; ` +
                  `deferring ${plannerFields.length} to the planner: ${plannerFields.map((f) => f.ref).join(', ')}`,
                )
              } else {
                log(`[matcher] No fields matched on "${pageContext}" — using the planner`)
              }
            } catch (matchErr) {
              logWarn(`[matcher] Matching failed: ${matchErr.message} — using the planner`)
            }
          }

          if (matcherOwnsPage) {
            // Nothing else to do — the queue is already complete.
          } else if (isExhaustedDelta) {
            const unplanned = findUnplannedRequired(inventory, [])
            if (unplanned.length > 0) {
              log(`[planner] Delta-planning ${unplanned.length} unplanned required field(s)`)
              try {
                planResult = await planPage({
                  pageContext,
                  inventory: { ...inventory, fields: unplanned },
                  answers: getAnswersForPage(pageContext, relevantText),
                  validationErrors, apiKey,
                  actionHistory: actionHistory.slice(-10),
                })
              } catch (planErr) {
                logWarn(`[planner] Delta plan failed: ${planErr.message}`)
              }
            }
          } else {
            // Fresh plan (new page, or re-plan after validation-error invalidation).
            // When the matcher already covered part of the page, the planner only
            // sees the fields it could not resolve.
            const plannerInventory = plannerFields
              ? { ...inventory, fields: plannerFields }
              : inventory
            const reason = plannerFields ? 'matcher gaps' :
              !currentPlan ? 'no plan' :
                currentPlan.pageContext !== pageContext ? 'page changed' : 'validation errors'
            log(`[planner] Planning page "${pageContext}" (${plannerInventory.fields.length} fields, reason: ${reason}, call #${plannerCallsForPage + 1})`)
            try {
              planResult = await planPage({
                pageContext,
                inventory: plannerInventory,
                answers: getAnswersForPage(pageContext, relevantText),
                validationErrors, apiKey,
                actionHistory: actionHistory.slice(-10),
              })
              log(`[planner] Got ${planResult.actions.length} actions`)
            } catch (planErr) {
              logWarn(`[planner] Plan failed: ${planErr.message} — falling back to vision`)
            }
          }

          if (planResult) {
            // Increment persistent call counter BEFORE creating the plan
            const newCallCount = plannerCallsForPage + 1
            pagePlannerCalls.set(pageContext, newCallCount)
            accumUsage(runUsage, planResult.usage)
            const logEntry = pageUsageLog.find((e) => e.page === pageContext)
            if (logEntry) {
              logEntry.calls++
              logEntry.prompt += planResult.usage?.prompt_tokens || 0
              logEntry.completion += planResult.usage?.completion_tokens || 0
            } else {
              pageUsageLog.push({
                page: pageContext,
                calls: 1,
                prompt: planResult.usage?.prompt_tokens || 0,
                completion: planResult.usage?.completion_tokens || 0,
              })
            }
            currentPlan = {
              pageContext,
              queue: queueWithAdvance(
                matcherActions ? [...matcherActions, ...planResult.actions] : planResult.actions,
                nextAdvanceAction({ inventory, pageContext }),
              ),
              inventory,
            }
          } else if (matcherActions) {
            // The planner failed but the matcher's fills are still valid; running
            // them lets the next step re-plan against a mostly complete page.
            currentPlan = {
              pageContext,
              queue: queueWithAdvance(
                matcherActions,
                nextAdvanceAction({ inventory, pageContext }),
              ),
              inventory,
            }
          } else if (!currentPlan || currentPlan.queue.length === 0) {
            currentPlan = null // will fall through to vision
          }
        }
      } else if (needNewPlan && plannerBudgetExhausted) {
        log(`[planner] Budget exhausted (${plannerCallsForPage}/${MAX_LLM_CALLS_PER_PAGE}) for page "${pageContext}" — using vision agent`)
        currentPlan = null
      }

      if (currentPlan && currentPlan.queue.length > 0) {
        action = currentPlan.queue.shift()
        while (action?.type === 'done' && currentPlan.queue.length) {
          log('[planner] Skipping premature "done" — application is not submitted yet')
          action = currentPlan.queue.shift()
        }
        if (action?.type === 'done') {
          action = nextAdvanceAction({ inventory: currentPlan.inventory, pageContext }) || action
        }

        // The planner emits a ref but no date parts, so a date fill would fall
        // back to matching the label against a list of known captions — and a
        // label the list does not cover ("TRAVEL DTE") is then filled as if it
        // were a plain text box, writing into whatever [id$=ref] resolves to.
        // The inventory already knows the three controls, so attach them.
        if (action && action.ref && !action.dateParts) {
          const dateField = (currentPlan.inventory?.fields || []).find(
            (field) => field.kind === 'date' && field.dateParts &&
              (field.ref === action.ref || controlName(field.ref) === controlName(action.ref)),
          )
          if (dateField) action.dateParts = dateField.dateParts
        }

        log(`[planner] Dequeued action: ${JSON.stringify(action).slice(0, 120)}`)
      }
    }

    if (!action) {
      // ── Vision agent fallback ────────────────────────────────────────────
      log('[vision] Taking screenshot and calling vision agent')
      const screenshot = await page.screenshot({ fullPage: false })
      try {
        action = await askAgent(screenshot, relevantText, actionHistory, apiKey, validationErrors)
        consecutiveErrors = 0
      } catch (err) {
        consecutiveErrors++
        logError(`Agent call failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`, err)
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logRunCost()
          throw new Error('Too many consecutive agent errors — aborting.')
        }
        await page.waitForTimeout(2000)
        continue
      }
    }

    logAction(action)

    if (action.type === 'defer') {
      const issue = {
        fieldLabel: action.fieldLabel || action.label || action.text || 'Unspecified item',
        reason: action.reason || 'Deferred during testing',
      }
      deferredIssues.push(issue)
      actionHistory.push({ type: '_deferred_for_review', ...issue })
      consecutiveErrors = 0
      logWarn(`⚠️ DEFERRED FOR LATER REVIEW: ${issue.fieldLabel} — ${issue.reason}`)
      continue
    }

    if (action.type === 'done') {
      // "done" while the page is still showing errors means the planner gave up
      // on a field it could not place. Reject it and re-plan while the retry
      // budget lasts; after that, still advance — the run is not finished until
      // Sign and Submit and the confirmation PDFs are saved.
      if (validationErrors.length > 0 && doneRejections < MAX_DONE_REJECTIONS) {
        doneRejections++
        logWarn(
          `Refusing "done" on page "${pageContext}" — ${validationErrors.length} unresolved ` +
          `validation error(s): ${validationErrors.join(' | ')} ` +
          `(attempt ${doneRejections}/${MAX_DONE_REJECTIONS})`,
        )
        currentPlan = null
        actionHistory.push({
          type: '_done_rejected',
          reason: `Page still reports: ${validationErrors.join(' | ')}`,
        })
        continue
      }

      for (const error of validationErrors) {
        deferredIssues.push({
          fieldLabel: `${pageContext}: form validation`,
          reason: error,
        })
      }
      const advance = nextAdvanceAction({
        inventory: currentPlan?.inventory,
        pageContext,
      })
      const inventory = currentPlan?.inventory
      currentPlan = null
      actionHistory.push({
        type: '_done_advanced',
        pageContext,
        advance: advance || null,
      })
      if (!advance) {
        logWarn(
          `Planner said "done" on "${pageContext}" — application is not submitted; re-planning.`,
        )
        continue
      }
      logWarn(
        `Planner said "done" on "${pageContext}" — application is not submitted; clicking ${advance.text || advance.type}.`,
      )
      currentPlan = { pageContext, queue: [advance], inventory }
      continue
    }

    if (action.type === 'solveCaptcha') {
      const result = await executeCaptchaAction(
        page, apiKey, pageContext, actionHistory, logDeferredSummary,
      )
      if (result.submitted) {
        logRunCost()
        return { outcome: 'submitted' }
      }
      currentPlan = null // page may have changed after CAPTCHA
      continue
    }

    // ── Execute action ───────────────────────────────────────────────────────
    let actionSucceeded = false
    try {
      await executeAction(page, action)
      actionHistory.push(action)
      failedActionCounts.delete(JSON.stringify(action))
      consecutiveErrors = 0
      actionSucceeded = true
      lastProgressAt = Date.now()
      await dismissCeacLeavePageDialog(page)
      if (await waitForHumanBotVerification(page)) {
        currentPlan = null
        lastProgressAt = Date.now()
        continue
      }
    } catch (err) {
      if (err.code === 'UI_TARGET_NOT_FOUND') {
        consecutiveErrors = 0
        logWarn(`Skipped translated-only/missing UI target: ${err.message}`)
        actionHistory.push({
          type: '_skipped_missing_ui',
          attemptedAction: action,
          reason: err.message,
        })
        await page.waitForTimeout(200)
        continue
      }
      if (err.message.startsWith('⛔ BLOCKED')) {
        log(err.message)
        log('Autofill has stopped at the submission boundary. Form is NOT submitted.')
        logDeferredSummary()
        logRunCost()
        return { outcome: 'blocked' }
      }

      const actionKey = JSON.stringify(action)
      const failureCount = (failedActionCounts.get(actionKey) || 0) + 1
      failedActionCounts.set(actionKey, failureCount)
      const actionTarget = String(action.text || action.label || action.fieldLabel || '')
      const canDefer = actionCanBeDeferredForTesting(action)
      if (canDefer && failureCount >= 2 && validationErrors.length === 0) {
        const issue = {
          fieldLabel: actionTarget || action.type,
          reason: `${err.message} (failed ${failureCount} times)`,
        }
        deferredIssues.push(issue)
        actionHistory.push({ type: '_deferred_for_review', attemptedAction: action, ...issue })
        consecutiveErrors = 0
        logWarn(`⚠️ DEFERRED FOR LATER REVIEW: ${issue.fieldLabel} — ${issue.reason}`)
        continue
      }

      consecutiveErrors++
      logError(`Action execution failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${err.message}`, err)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logRunCost()
        throw new Error('Too many consecutive action failures — aborting.')
      }
      actionHistory.push({ type: '_error', ...action, error: err.message })
      // If the action came from the planner and failed, invalidate the plan
      // so the next step re-plans or falls back to vision
      if (currentPlan) {
        currentPlan = null
        log('[planner] Plan invalidated by action failure — will re-plan')
      }
    }

    // ── Native alphabet guard ────────────────────────────────────────────────
    if (actionSucceeded && action.type === 'fill' && /native alphabet/i.test(action.label || '') && action.value) {
      nativeAlphabetValue = action.value
      await page.evaluate((val) => {
        if (window.__nativeGuardInterval) clearInterval(window.__nativeGuardInterval)
        window.__nativeGuardValue = val
        window.__nativeGuardInterval = setInterval(() => {
          const input = document.querySelector(
            '[id$="tbxAPP_FULL_NAME_NATIVE"], [id*="FULL_NAME_NATIVE"]:not([type="checkbox"])'
          )
          const cb = document.querySelector(
            '[id$="cbexAPP_FULL_NAME_NATIVE_NA"], [id$="cbxAPP_FULL_NAME_NATIVE"], [id*="FULL_NAME_NATIVE"][type="checkbox"]'
          )
          if (cb && cb.checked) {
            cb.checked = false
            cb.dispatchEvent(new Event('change', { bubbles: true }))
          }
          if (input && input.disabled) {
            input.disabled = false
          }
          if (input && !input.value && window.__nativeGuardValue) {
            input.value = window.__nativeGuardValue
            input.dispatchEvent(new Event('input',  { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }, 200)
      }, action.value).catch(() => {})
      log(`🔒 Native alphabet guard active for: "${action.value}"`)
    }

    // ── Post-action: check if inventory changed (postback-triggered reveal) ──
    if (actionSucceeded && currentPlan && PLANNER_PAGES.has(pageContext)) {
      const mightTriggerPostback =
        action.type === 'radio' ||
        action.type === 'selectOption' ||
        action.type === 'check' ||
        action.type === 'wait' ||
        (currentPlan.inventory?.fields.find((f) => f.ref === action.ref)?.triggersPostback)

      if (mightTriggerPostback) {
        try {
          await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
          await page.waitForTimeout(600)
          if (action.type === 'radio' && /specific travel/i.test(action.label || '')) {
            await page.locator('input[id$="tbxTRAVEL_LOS"]').first()
              .waitFor({ state: 'visible', timeout: 8000 })
              .catch(() => {})
          }
          const newInventory = await extractPageInventory(page)
          if (newInventory.signature !== currentPlan.inventory?.signature) {
            const diff = diffInventory(currentPlan.inventory || { fields: [] }, newInventory)
            currentPlan.inventory = newInventory
            const plannedRefs = new Set(currentPlan.queue.map((a) => a.ref).filter(Boolean))
            // Length-of-stay (and other postback fields) often have no nearby
            // validator until Next fails, so do not require `required: true`.
            let newRequired = revealedFieldsToFill(diff.added, plannedRefs)

            // Try to cover the revealed fields deterministically before paying for
            // a delta plan.
            if (newRequired.length > 0 && MATCHER_PAGES.has(pageContext)) {
              try {
                const rematched = matchPage({
                  pageContext,
                  inventory: { ...newInventory, fields: newRequired },
                  answers: relevantText,
                  answerSheet: answerSheet?.[pageContext],
                })
                if (rematched.actions.length > 0) {
                  const insertAt = currentPlan.queue.findIndex((a) => a.type !== 'wait')
                  if (insertAt >= 0) {
                    currentPlan.queue.splice(insertAt, 0, ...rematched.actions)
                  } else {
                    currentPlan.queue.push(...rematched.actions)
                  }
                  log(`[matcher] Covered ${rematched.actions.length} revealed field(s), no LLM call`)
                }
                const covered = new Set(rematched.resolvedRefs || [])
                newRequired = newRequired.filter(
                  (field) => !covered.has(field.ref) && (field.required || isIntendedStayLengthField(field)),
                )
              } catch (rematchErr) {
                logWarn(`[matcher] Rematch of revealed fields failed: ${rematchErr.message}`)
              }
            }
            newRequired = newRequired.filter(
              (field) => field.required || isIntendedStayLengthField(field),
            )

            if (newRequired.length > 0 && (pagePlannerCalls.get(pageContext) || 0) < MAX_LLM_CALLS_PER_PAGE) {
              log(`[planner] ${newRequired.length} new required field(s) revealed — delta-planning`)
              try {
                const delta = await planPage({
                  pageContext,
                  inventory: { ...newInventory, fields: newRequired },
                  answers: getAnswersForPage(pageContext, relevantText),
                  validationErrors: newInventory.errors,
                  apiKey,
                  actionHistory: actionHistory.slice(-10),
                })
                pagePlannerCalls.set(pageContext, (pagePlannerCalls.get(pageContext) || 0) + 1)
                accumUsage(runUsage, delta.usage)
                const deltaActions = stripDoneActions(delta.actions)
                if (!deltaActions.length) {
                  log('[planner] Delta plan was only "done" — keeping Next; application is not submitted yet')
                } else {
                  const insertAt = currentPlan.queue.findIndex((a) => a.type !== 'wait')
                  if (insertAt >= 0) {
                    currentPlan.queue.splice(insertAt, 0, ...deltaActions)
                  } else {
                    currentPlan.queue.push(...deltaActions)
                  }
                  log(`[planner] Delta plan added ${deltaActions.length} action(s)`)
                }
              } catch (deltaErr) {
                logWarn(`[planner] Delta plan failed: ${deltaErr.message}`)
              }
            }
          }
        } catch { /* ignore inventory refresh errors */ }
        // Don't double-wait below — the networkidle wait above is enough
        continue
      }
    }

    // ── Wait for page to settle after every action ───────────────────────────
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
    } catch { /* continue */ }
    try { await page.waitForTimeout(800) } catch { /* browser navigated */ }
  }

  logDeferredSummary()
  logRunCost()
  log('Agent loop finished.')
  throw new Error(`Agent reached step limit (${MAX_STEPS}) without completing.`)
}
