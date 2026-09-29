#!/usr/bin/env node
import 'dotenv/config'
/**
 * DS-160 Auto-fill Entry Point
 *
 * Usage:
 *   npm run autofill -- people/nira_biton.txt
 *   node autofill/fill-ds160.js --input /path/to/first_last.txt
 *   node autofill/fill-ds160.js --input /path/to/first_last.txt --retrieve --app-id AA00XXXXXX
 *
 * Starts a new application (or retrieves one), captures the CEAC Application ID,
 * then fills the form. A failed fill can be retried by retrieving that same
 * Application ID. After two failed retrieves, the same applicant is started
 * again from the beginning. Retries never run unless the current fill fails. A stall or dead tab closes the CEAC page and retrieves
 * instead of continuing on the stuck session. The Application ID is saved
 * locally so a later desktop rerun resumes with retrieve, even after a failure.
 *
 * The first_last.txt file is downloaded from the app UI after a successful
 * translation (click "Auto-fill DS-160" in the translation result panel).
 *
 * Completes submission, saves the confirmation page as a PDF, and uploads it
 * to the applicant's existing S3 document directory.
 *
 * Logs every section change and every action to stdout.
 * Prefers attaching to Chrome on port 9222. If that fails and Chrome is not
 * running, opens your real Chrome profile (the one that already passed CEAC).
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'
import {
  runAgent,
  log,
  logSection,
  logError,
  logWarn,
  hasCanonicalSections,
  waitForHumanBotVerification,
  pageLooksLikeCloudflareChallenge,
  isFatalCloudflareError,
  isCeacServiceUnavailableError,
  throwIfCeacServiceUnavailable,
  clickStartApplication,
  disarmCeacUnload,
  disarmCeacUnloadInPage,
} from './agent.js'
import { saveConfirmationPdf } from './save-confirmation-pdf.js'
import { parseApplicantSource } from './parse-applicant-source.js'
import {
  APP_ID_RE,
  lookupApplicationId,
  parseApplicationId,
  rememberApplicationId,
  repoRootFrom,
} from './application-id-store.js'

export { APP_ID_RE, parseApplicationId }
export const MAX_FILL_ATTEMPTS = 3
/** After this many failed retrieves, start the same applicant from the beginning. */
export const MAX_RETRIEVE_FAILURES_BEFORE_FRESH = 2
const REPO_ROOT = repoRootFrom(import.meta.url)
// CEAC needs a moment after an exit before it will hand the same application
// back out; retrieving immediately tends to come back as if it were still open.
const SESSION_RELEASE_MS = 5_000
const STALL_SESSION_RELEASE_MS = 8_000

let fillAborted = false

export function isFillAborted() {
  return fillAborted
}

export function requestAbortFill(reason = 'Stopped by user') {
  if (fillAborted) return
  fillAborted = true
  log(`⛔ ${reason} — cancelling remaining retries`)
}

if (typeof process.loadEnvFile === 'function' && fs.existsSync(path.resolve('.env'))) {
  process.loadEnvFile(path.resolve('.env'))
}

/** waitForTimeout that never throws even if the page navigates away */
async function safeWait(page, ms) {
  try { await page.waitForTimeout(ms) } catch { /* page navigated or closed */ }
}

/** waitForLoadState that never throws */
async function safeLoad(page, state = 'domcontentloaded', timeout = 12000) {
  try { await page.waitForLoadState(state, { timeout }) } catch { /* continue */ }
  await waitForHumanBotVerification(page)
}

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function argValue(args, flag) {
  const idx = args.indexOf(flag)
  return idx >= 0 ? (args[idx + 1] || '') : ''
}

function parseArgs() {
  const args = process.argv.slice(2)
  const inputFile = argValue(args, '--input')
  if (!inputFile) {
    console.error(
      'Usage: node autofill/fill-ds160.js --input <path-to-first_last.txt> [--form-id <uuid>]',
    )
    console.error(
      '       node autofill/fill-ds160.js --input <path> --retrieve --app-id <AA…> [--form-id <uuid>]',
    )
    console.error('  Download first_last.txt from the app UI after a successful translation.')
    process.exit(1)
  }

  const retrieve = args.includes('--retrieve')
  const fresh = args.includes('--fresh')
  const appId = parseApplicationId(argValue(args, '--app-id'))
  if (fresh && retrieve) {
    console.error('Use either --fresh or --retrieve, not both.')
    process.exit(1)
  }
  if (retrieve && !appId) {
    console.error('Retrieve mode requires --app-id <10-character Application ID>, e.g. AA00FPUEXZ')
    process.exit(1)
  }

  const securityAnswerExplicit = args.includes('--security-answer')
  return {
    inputFile,
    formId: argValue(args, '--form-id'),
    retrieve,
    fresh,
    appId,
    surname: argValue(args, '--surname').trim().toUpperCase(),
    birthYear: argValue(args, '--birth-year').trim(),
    securityAnswer: argValue(args, '--security-answer').trim(),
    securityAnswerExplicit,
  }
}

// ─── Read translated text ────────────────────────────────────────────────────

function readTranslatedText(filePath) {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    console.error(`Input file not found: ${resolved}`)
    process.exit(1)
  }
  const { text, embeddedFormId, answerSheet, answerSheetError } = parseApplicantSource(
    fs.readFileSync(resolved, 'utf8'),
  )

  if (answerSheet) {
    log(`Loaded DS160_ANSWER_SHEET (${Object.keys(answerSheet).length} sections)`)
  } else if (answerSheetError) {
    log(`Warning: DS160_ANSWER_SHEET present but not valid JSON — using prose only (${answerSheetError})`)
  }

  if (!text) {
    console.error(`Input file is empty: ${resolved}`)
    process.exit(1)
  }

  // Without section headers the text cannot be split per page, so every page
  // would be offered the whole document and could match another page's answers.
  // An answer sheet sidesteps that entirely — it is already keyed by page.
  if (!hasCanonicalSections(text) && !answerSheet) {
    console.error(
      `Input file has no recognizable DS-160 sections and no answer sheet: ${resolved}\n` +
      'Every page would be matched against the whole document, which fills wrong values silently.\n' +
      'Re-run the translation to produce a sectioned document with a DS160_ANSWER_SHEET block.',
    )
    process.exit(1)
  }
  if (!hasCanonicalSections(text)) {
    log('Warning: no section headers found — relying on the answer sheet, prose will be ignored per page')
  }

  log(`Loaded translated text from: ${resolved} (${text.length} chars)`)
  return { text, embeddedFormId, answerSheet }
}

/** Same security Q/A the autofill sets when starting a new application (agent prompt). */
const DS160_SECURITY_QUESTION = 'WHAT WAS YOUR HOME PHONE NUMBER WHEN YOU WERE A CHILD?'
const DS160_SECURITY_ANSWER = '049824393'

function normalizeSecurityQuestion(value = '') {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Read the CEAC Application ID banner shown on every in-progress form page. */
export async function extractApplicationId(page) {
  const selectors = ['#ctl00_lblAppID', '#ctl00_lblRecoveryAppID']
  for (const sel of selectors) {
    const loc = page.locator(sel).first()
    if ((await loc.count().catch(() => 0)) === 0) continue
    const id = parseApplicationId(await loc.innerText().catch(() => ''))
    if (id) return id
  }
  return ''
}

export async function waitForApplicationId(page, { timeoutMs = 10_000 } = {}) {
  try {
    await page.locator('#ctl00_lblAppID, #ctl00_lblRecoveryAppID').first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
  } catch { /* extract whatever is present */ }
  return extractApplicationId(page)
}

function createAppIdTracker(initial = '', { onChange } = {}) {
  let appId = parseApplicationId(initial)
  return {
    get() {
      return appId
    },
    note(id) {
      const parsed = parseApplicationId(id)
      if (parsed && parsed !== appId) {
        appId = parsed
        log(`📋 Application ID: ${appId}`)
        try { onChange?.(appId) } catch { /* persistence is best-effort */ }
      }
      return appId
    },
    async capture(page) {
      return this.note(await extractApplicationId(page))
    },
    async wait(page, timeoutMs = 8_000) {
      return this.note(await waitForApplicationId(page, { timeoutMs }))
    },
    /** Drop the in-memory id so a fresh application is not filed under the old one. */
    forget() {
      appId = ''
    },
  }
}

/**
 * Retrieve only after Personal Information 1 has been saved.
 * An Application ID from before that page starts a new application instead.
 */
export function nextAttemptMode(attempt, {
  startWithRetrieve = false,
  appId = '',
  personal1Saved = false,
  retrieveFailures = 0,
} = {}) {
  const canRetrieve =
    retrieveFailures < MAX_RETRIEVE_FAILURES_BEFORE_FRESH &&
    personal1Saved &&
    Boolean(parseApplicationId(appId))
  if (attempt === 1) return startWithRetrieve && canRetrieve ? 'retrieve' : 'setup'
  return canRetrieve ? 'retrieve' : 'setup'
}

/**
 * CEAC's retrieve field is the first 5 characters of the surname as entered.
 * Nothing is removed: a space in a two-word surname counts, so "BEN TADMOR" is "BEN T".
 */
export function firstFiveSurnameLetters(surname = '') {
  return String(surname).trim().toUpperCase().slice(0, 5)
}

/** Pull surname prefix + birth year + security answer from translated text / fill prompt. */
function extractRetrieveCredentials(text, overrides = {}, { required = true } = {}) {
  const surnameMatch = text.match(/^\s*Surname\s*:\s*(.+)\s*$/im)
  const dobMatch = text.match(/^\s*Date of Birth\s*:\s*([0-9]{1,2})[\/\-.]([0-9]{1,2})[\/\-.]([0-9]{4})\s*$/im)
  const answerFromText =
    text.match(/^\s*Security Answer\s*:\s*(.+)\s*$/im)?.[1]?.trim() ||
    text.match(/^\s*Security question answer\s*:\s*(.+)\s*$/im)?.[1]?.trim() ||
    text.match(/Enter the answer:\s*\*?\*?([^*\s]+)\*?\*?/i)?.[1]?.trim() ||
    ''

  const surname5 = firstFiveSurnameLetters(overrides.surname || surnameMatch?.[1] || '')
  const birthYear = overrides.birthYear || dobMatch?.[3] || ''
  const securityAnswer =
    (overrides.securityAnswerExplicit && overrides.securityAnswer) ||
    overrides.securityAnswer ||
    answerFromText ||
    DS160_SECURITY_ANSWER

  if (!surname5 || !/^[0-9]{4}$/.test(birthYear)) {
    if (required) {
      if (!surname5) {
        console.error('Could not determine surname for retrieve. Pass --surname <LASTNAME>.')
      } else {
        console.error('Could not determine birth year for retrieve. Pass --birth-year YYYY.')
      }
      process.exit(1)
    }
    log('⚠️  Incomplete retrieve credentials — retrieve retries will start a new application instead')
    return null
  }

  log(
    `Retrieve credentials from applicant data/prompt: surname5=${surname5}, yob=${birthYear}, ` +
      `securityAnswer=${securityAnswer} (setup Q: ${DS160_SECURITY_QUESTION})`,
  )

  return {
    surname5,
    birthYear,
    securityAnswer,
    securityAnswerExplicit: Boolean(overrides.securityAnswerExplicit),
  }
}

function isRecoveryPage(page) {
  return /Recovery\.aspx/i.test(page.url())
}

function isInsideDs160Application(page) {
  const url = page.url()
  if (isRecoveryPage(page) || /Default\.aspx/i.test(url) || /AppError\.aspx/i.test(url)) return false
  return /\/GenNIV\/General\//i.test(url) || /complete_/i.test(url) || /photo_/i.test(url)
}

/** Known CEAC Recovery.aspx Application ID box — never treat this as surname. */
export const RECOVERY_APP_ID_SELECTORS = [
  '#ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxApplicationID',
  'input[id*="ApplicationID" i]',
  'input[name*="ApplicationID" i]',
  'input[id*="AppId" i]',
  'input[name*="AppId" i]',
]

export function classifyRecoveryInput({ id = '', name = '', maxLength = null } = {}) {
  const blob = `${id} ${name}`
  if (/captcha|codetextbox/i.test(blob)) return 'captcha'
  if (/applicationid|appid/i.test(blob)) return 'application_id'
  if (/surname|lastname|lname/i.test(blob)) return 'surname'
  if (/yearofbirth|birthyear|dobyear/i.test(blob)) return 'year'
  if (/securityanswer|txtanswer/i.test(blob) || (/answer/i.test(blob) && !/application/i.test(blob))) {
    return 'answer'
  }
  if (maxLength === 4) return 'year'
  return 'unknown'
}

async function recoveryInputVisible(page, selector) {
  return page.locator(selector).first().isVisible({ timeout: 800 }).catch(() => false)
}

/**
 * Classify Recovery.aspx by its actual inputs, not instruction text.
 * The Application ID page mentions "First 5 letters of Surname" in help copy.
 */
export async function recoveryPageKind(page) {
  const hasAppId = await recoveryInputVisible(page, RECOVERY_APP_ID_SELECTORS.join(', '))
  const hasSurname = await recoveryInputVisible(
    page,
    'input[id*="Surname" i], input[name*="Surname" i], input[id*="LastName" i]',
  )
  const hasYear = await recoveryInputVisible(
    page,
    'input[id*="YearOfBirth" i], input[name*="YearOfBirth" i], input[id*="BirthYear" i], ' +
      'input[name*="BirthYear" i], input[id*="DOBYear" i], input[name*="DOBYear" i]',
  )
  const hasAnswer = await recoveryInputVisible(
    page,
    'input[id*="SecurityAnswer" i], input[name*="SecurityAnswer" i], input[id*="txtAnswer" i]',
  )
  if (hasSurname || (hasYear && hasAnswer)) return hasAppId ? 'combined' : 'security'
  if (hasAppId) return 'application_id'
  return 'unknown'
}

async function fillFirstVisible(page, selectors, value, label) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first()
      await el.waitFor({ state: 'visible', timeout: 2500 })
      if (await el.isDisabled().catch(() => false)) continue
      const readonly = await el.getAttribute('readonly')
      if (readonly !== null) continue
      await el.fill('')
      await el.fill(value)
      log(`✅ Filled ${label}: "${value}" via ${sel}`)
      return true
    } catch { /* try next */ }
  }
  return false
}

/** CEAC Recovery fields often lack proper <label for>, so locate the input in the same table row. */
async function fillRecoveryFieldByRowLabel(page, labelPattern, value, fieldName) {
  const row = page.locator('tr').filter({ hasText: labelPattern }).first()
  if ((await row.count().catch(() => 0)) === 0) return false
  const input = row.locator('input[type="text"], input:not([type]), input[type="password"]').first()
  if ((await input.count().catch(() => 0)) === 0) return false
  try {
    await input.waitFor({ state: 'visible', timeout: 800 })
    if (await input.isDisabled().catch(() => false)) return false
    const readonly = await input.getAttribute('readonly')
    if (readonly !== null) return false
    const id = (await input.getAttribute('id').catch(() => '')) || ''
    const name = (await input.getAttribute('name').catch(() => '')) || ''
    const kind = classifyRecoveryInput({ id, name })
    if (kind === 'application_id' && fieldName !== 'Application ID') return false
    await input.click({ timeout: 1000 })
    await input.fill('')
    await input.fill(value)
    log(`✅ Filled ${fieldName}: "${value}" via row label ${labelPattern}`)
    return true
  } catch {
    return false
  }
}

export async function fillRecoveryApplicationId(page, appId) {
  return (
    (await fillFirstVisible(page, RECOVERY_APP_ID_SELECTORS, appId, 'Application ID')) ||
    (await fillRecoveryFieldByRowLabel(page, /Your Application ID|Application ID/i, appId, 'Application ID'))
  )
}

/** Fallback when CEAC uses opaque ids on the security-questions step only. */
export async function fillRecoverySecurityByEditableOrder(page, { surname5, birthYear, securityAnswer }) {
  const meta = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].filter((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (!['text', 'password', ''].includes(type)) return false
      if (el.disabled || el.readOnly) return false
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      if (el.offsetParent === null && style.position !== 'fixed') return false
      return true
    })
    return inputs.map((el, index) => ({
      index,
      id: el.id || '',
      name: el.name || '',
      value: el.value || '',
      maxLength: el.maxLength > 0 ? el.maxLength : null,
    }))
  })

  const classified = meta.map((m) => ({ ...m, kind: classifyRecoveryInput(m) }))
  const hasAnswerKind = classified.some((m) => m.kind === 'answer')
  const empty = { filledSurname: false, filledYear: false, filledAnswer: false, answerOnPage: hasAnswerKind, meta }
  if (meta.length === 0) return empty

  log(`Recovery editable inputs: ${meta.map((m) => `#${m.id || '?'} name=${m.name || '?'} maxlen=${m.maxLength ?? '-'}`).join(' | ')}`)

  const security = classified.filter((m) => m.kind !== 'application_id' && m.kind !== 'captcha')
  if (security.length < 2) return empty
  const answerOnPage = hasAnswerKind || security.length > 2

  let surnameIdx = security.find((m) => m.kind === 'surname')?.index ?? -1
  let yearIdx = security.find((m) => m.kind === 'year')?.index ?? -1
  let answerIdx = security.find((m) => m.kind === 'answer')?.index ?? -1

  const unused = () => security.map((m) => m.index).filter((i) => ![surnameIdx, yearIdx, answerIdx].includes(i))

  if (surnameIdx < 0) surnameIdx = unused()[0] ?? -1
  if (yearIdx < 0) {
    const shortYear = unused().find((i) => meta[i].maxLength === 4)
    yearIdx = shortYear ?? unused()[0] ?? -1
  }
  if (answerIdx < 0) {
    const rest = unused()
    answerIdx = rest[rest.length - 1] ?? -1
  }

  async function fillAt(idx, value, label) {
    if (idx < 0 || idx >= meta.length) return false
    const target = meta[idx]
    const kind = classifyRecoveryInput(target)
    if (kind === 'application_id' || kind === 'captcha') return false
    try {
      const locator = target.id
        ? page.locator(`[id="${target.id}"]`)
        : target.name
          ? page.locator(`[name="${target.name}"]`).first()
          : page.locator('input[type="text"]:visible').nth(idx)
      await locator.waitFor({ state: 'visible', timeout: 2000 })
      await locator.fill('')
      await locator.fill(value)
      log(`✅ Filled ${label}: "${value}" via ${target.id || target.name || `editable[${idx}]`}`)
      return true
    } catch (err) {
      log(`⚠️  Ordered fill failed for ${label} at [${idx}]: ${err.message}`)
      return false
    }
  }

  const filledSurname = await fillAt(surnameIdx, surname5, 'Surname')
  const filledYear = await fillAt(yearIdx, birthYear, 'Year of Birth')
  const filledAnswer = answerOnPage
    ? await fillAt(answerIdx, securityAnswer, 'Security Answer')
    : false
  return { filledSurname, filledYear, filledAnswer, answerOnPage, meta }
}

/** Surname and year are enough when this Recovery page has no answer box. */
export function retrieveSecurityReady({ filledSurname, filledYear, filledAnswer, answerOnPage } = {}) {
  if (!filledSurname || !filledYear) return false
  return Boolean(filledAnswer) || answerOnPage === false
}

async function readVisibleSecurityQuestion(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || ''
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^what\b.+\?$/i.test(line) || /name did your family/i.test(line) || /home phone number when you were a child/i.test(line)) {
        return line
      }
      // Question may be a long label above an empty answer box
      if (/\?$/.test(line) && /child|phone|grandmother|grandfather|school|spouse|friend|street|sibling|cousin|teacher|animal|toy/i.test(line)) {
        return line
      }
    }
    return ''
  })
}

// ─── DS-160 initial setup ────────────────────────────────────────────────────

async function openCeacLanding(page, { force = false } = {}) {
  const url = page.url() || ''
  if (force) {
    log('Fresh start — opening the DS-160 landing page instead of the saved application.')
  } else if (!shouldReloadCeacLanding(url)) {
    if (await pageLooksLikeCloudflareChallenge(page)) {
      log('CEAC security check is showing — complete it in Chrome. Not reloading.')
      await waitForHumanBotVerification(page)
    } else {
      log(`Already on CEAC (${url}) — not reloading, so Cloudflare is not triggered again.`)
    }
    await waitForHumanBotVerification(page)
    await throwIfCeacServiceUnavailable(page)
    await safeWait(page, 2000)
    return
  }
  log('Navigating to DS-160…')
  await page.goto('https://ceac.state.gov/GenNIV/Default.aspx', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await waitForHumanBotVerification(page)
  await throwIfCeacServiceUnavailable(page)
  await safeWait(page, 2000)
}

/** Reload only when this tab is not already on CEAC (including the security-check page). */
export function shouldReloadCeacLanding(url) {
  const href = String(url || '')
  if (/identix\.state\.gov/i.test(href)) return true
  return !/ceac\.state\.gov/i.test(href)
}

export function isClosedBrowserError(err) {
  return /has been closed|target closed|browser has been closed|context closed/i.test(
    String(err?.message || err || ''),
  )
}

export function isStallError(err) {
  return /stall detected/i.test(String(err?.message || err || ''))
}

function errorText(err) {
  return String(err?.message || err || '')
}

export function isStuckSessionError(err) {
  return isStallError(err) || isClosedBrowserError(err) || /PAGE CLOSED|tab crashed|PAGE CRASHED/i.test(errorText(err))
}

function withTimeout(promise, ms) {
  let timer
  const work = Promise.resolve(promise).catch(() => false)
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ])
}

export const APPLICATION_ALREADY_SUBMITTED_PREFIX = 'APPLICATION_ALREADY_SUBMITTED'

export function isAlreadySubmittedRetrieveDialog(text = '') {
  const blob = String(text || '')
  return /attempting to retrieve has been submitted/i.test(blob)
    || /application you are attempting to retrieve has been submitted/i.test(blob)
}

export function isApplicationAlreadySubmittedError(err) {
  const message = String(err?.message || err || '')
  return message.startsWith(APPLICATION_ALREADY_SUBMITTED_PREFIX)
    || isAlreadySubmittedRetrieveDialog(message)
}

export async function pageShowsAlreadySubmittedDialog(page) {
  if (!page || page.isClosed?.()) return false
  const text = await page.locator('body').innerText().catch(() => '')
  if (isAlreadySubmittedRetrieveDialog(text)) return true
  const viewConfirm = await page.getByText(/View Confirmation Page/i).isVisible().catch(() => false)
  const createNew = await page.getByText(/Create a New Application/i).isVisible().catch(() => false)
  return Boolean(viewConfirm && createNew)
}

export async function throwIfApplicationAlreadySubmitted(page) {
  if (!(await pageShowsAlreadySubmittedDialog(page))) return
  throw new Error(
    `${APPLICATION_ALREADY_SUBMITTED_PREFIX}: The DS-160 application you are attempting to retrieve has been submitted. ` +
    'Stopping this applicant — not retrying and not creating a new application.',
  )
}

/** Identix 503 and a closed tab with a captured Application ID should retrieve, not quit. */
export function shouldRetryFillAfterError(err, { hasAppId = false, abort = false } = {}) {
  if (abort || fillAborted) return false
  if (isApplicationAlreadySubmittedError(err)) return false
  if (isFatalCloudflareError(err)) return false
  if (isCeacServiceUnavailableError(err)) return true
  if (isStallError(err)) return true
  if (isClosedBrowserError(err)) return hasAppId
  return true
}

const CAPTCHA_INPUT_SELECTORS = [
  '#ctl00_SiteContentPlaceHolder_CodeTextBox',
  '#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha',
  '#ctl00_SiteContentPlaceHolder_ucAppSecurityQuestion_txtcaptcha',
  'input[type="text"][id$="CodeTextBox"]',
  'input[type="text"][id*="txtcaptcha" i]',
  'input[name*="captcha" i]',
  'input[id*="captcha" i]',
]

const CAPTCHA_IMAGE_SELECTOR =
  'img.LBD_CaptchaImage, img[id$="CaptchaImage"], img[alt="CAPTCHA"], img[src*="aptcha" i], img[id*="aptcha" i]'

async function captchaImageVisible(page) {
  return page.locator(CAPTCHA_IMAGE_SELECTOR).first().isVisible({ timeout: 800 }).catch(() => false)
}

async function captchaInputVisible(page) {
  for (const sel of CAPTCHA_INPUT_SELECTORS) {
    if (await page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) return true
  }
  return false
}

/** The retrieve Application ID page sometimes adds this BotDetect prompt beside the ID. */
async function codeAsShownVisible(page) {
  return page.getByText(/Enter the code as shown/i).first().isVisible({ timeout: 500 }).catch(() => false)
}

/** Still the retrieve screen from the screenshot, even if the URL looks like an in-progress form. */
async function retrieveChallengeStillShowing(page) {
  const heading = await page
    .locator('h1, h2')
    .filter({ hasText: /Retrieve a DS-160 Application/i })
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false)
  if (heading) return true
  if (!(await codeAsShownVisible(page))) return false
  return page
    .getByRole('button', { name: /retrieve application/i })
    .or(page.locator('input[type="submit"][value*="Retrieve Application" i], input[type="button"][value*="Retrieve Application" i]'))
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false)
}

async function captchaPromptVisible(page) {
  return (await captchaImageVisible(page)) || (await captchaInputVisible(page)) || (await codeAsShownVisible(page))
}

/**
 * Type an already-solved code into the CAPTCHA box.
 * On retrieve, that box is the "Enter the code as shown" field next to the image,
 * and its id is not always one of the landing-page captcha ids.
 */
export async function fillCaptchaAnswer(page, answer) {
  const value = String(answer || '')
  if (!value) return false

  for (const sel of CAPTCHA_INPUT_SELECTORS) {
    const el = page.locator(sel).first()
    if (!(await el.isVisible({ timeout: 250 }).catch(() => false))) continue
    await el.fill(value)
    log(`CAPTCHA filled: "${value}" via ${sel}`)
    return true
  }

  const rows = page.locator('tr').filter({ hasText: /Enter the code as shown/i })
  const rowCount = await rows.count().catch(() => 0)
  for (let i = 0; i < rowCount; i++) {
    const inputs = rows.nth(i).locator('input[type="text"], input:not([type])')
    const n = await inputs.count().catch(() => 0)
    for (let j = 0; j < n; j++) {
      const input = inputs.nth(j)
      const id = (await input.getAttribute('id').catch(() => '')) || ''
      const name = (await input.getAttribute('name').catch(() => '')) || ''
      if (classifyRecoveryInput({ id, name }) === 'application_id') continue
      if (!(await input.isVisible({ timeout: 250 }).catch(() => false))) continue
      await input.fill(value)
      log(`CAPTCHA filled: "${value}" via "Enter the code as shown"`)
      return true
    }
  }

  const following = page.locator(
    'xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "enter the code as shown")]/following::input[not(@type) or @type="text"][1]',
  ).first()
  if (await following.isVisible({ timeout: 400 }).catch(() => false)) {
    const id = (await following.getAttribute('id').catch(() => '')) || ''
    const name = (await following.getAttribute('name').catch(() => '')) || ''
    if (classifyRecoveryInput({ id, name }) !== 'application_id') {
      await following.fill(value)
      log(`CAPTCHA filled: "${value}" next to "Enter the code as shown"`)
      return true
    }
  }

  log('⚠️  Could not fill CAPTCHA input')
  return false
}

/**
 * OCR the CEAC image CAPTCHA and type the answer. This is the same path a new
 * application uses: solveCaptchaOnPage, then the code box beside the image.
 */
async function solveAndFillCaptcha(page, apiKey) {
  if (await codeAsShownVisible(page)) {
    await page.locator(CAPTCHA_IMAGE_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  }
  const { solveCaptchaOnPage } = await import('./agent.js')
  const answer = await solveCaptchaOnPage(page, apiKey)
  if (!answer) return false
  return fillCaptchaAnswer(page, answer)
}

/**
 * Handles the pre-form setup:
 *   - Select embassy location
 *   - Solve initial CAPTCHA
 *   - Click "Start an Application"
 *   - Check "I agree"
 *   - Set security question + answer
 *
 * After this function returns, the agent loop takes over for all form sections.
 */
async function setupApplication(page, apiKey, appIdTracker = createAppIdTracker(), { fresh = false } = {}) {

  // ── Step 1: Navigate ────────────────────────────────────────────────────────
  logSection('Step 1 — Navigate to DS-160')
  await openCeacLanding(page, { force: fresh })

  // ── Step 2: Select embassy location ────────────────────────────────────────
  // The DS-160 landing page has TWO dropdowns:
  //   1. Language selector (English/Arabic/Hebrew/…)  ← skip this one
  //   2. Embassy/consulate location (Israel - Tel Aviv/…)  ← target this one
  // The CAPTCHA is already visible on page load — no reload needed before it.
  logSection('Step 2 — Select Embassy Location')
  log('Looking for embassy dropdown (second select or by ASP.NET ID)…')
  let locationSelected = false
  try {
    // Try known ASP.NET IDs first (most reliable)
    const knownIds = [
      '#ctl00_SiteContentPlaceHolder_ucLocationSearch_ddlLocation',
      'select[id$="ddlLocation"]',
      'select[name$="ddlLocation"]',
    ]
    let ddl = null
    for (const sel of knownIds) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'visible', timeout: 3000 })
        ddl = el
        log(`Found embassy dropdown via: ${sel}`)
        break
      } catch { /* try next */ }
    }

    // Fallback: scan ALL select elements, skip the one with language options
    if (!ddl) {
      const allSelects = await page.locator('select').all()
      log(`Found ${allSelects.length} select elements on page`)
      for (let i = 0; i < allSelects.length; i++) {
        const opts = await allSelects[i].locator('option').all()
        const texts = await Promise.all(opts.slice(0, 3).map(o => o.textContent()))
        log(`Select[${i}] first 3 options: ${texts.map(t => t?.trim()).join(' | ')}`)
        // Skip the language selector (contains "Arabic", "Hebrew", "French" etc.)
        const isLanguage = texts.some(t => t && (t.includes('Arabic') || t.includes('Hebrew') || t.includes('Français') || t.includes('العربية')))
        if (!isLanguage) {
          ddl = allSelects[i]
          log(`Using select[${i}] as embassy dropdown`)
          break
        }
      }
    }

    if (ddl) {
      const options = await ddl.locator('option').all()
      for (const opt of options) {
        const txt = (await opt.textContent())?.trim() || ''
        if (txt.includes('Tel Aviv') || txt.includes('TEL AVIV')) {
          const val = await opt.getAttribute('value')
          if (val && val !== '') {
            await ddl.selectOption(val)
            locationSelected = true
            log(`✅ Embassy selected: "${txt}"`)
            // Brief pause for any partial postback
            await safeWait(page, 1500)
            break
          }
        }
      }
      if (!locationSelected) {
        // Log all options so we know what text the site actually uses
        const allTexts = await Promise.all(options.map(o => o.textContent()))
        log(`Embassy options: ${allTexts.map(t => t?.trim()).filter(Boolean).join(' | ')}`)
      }
    } else {
      log('⚠️  Could not find any embassy dropdown')
    }
  } catch (err) {
    log(`⚠️  Embassy dropdown error: ${err.message}`)
  }

  if (!locationSelected) {
    log('⚠️  Embassy not selected — agent will handle it on the next page')
  }

  // ── Step 3: Solve CAPTCHA (present on the same landing page) ───────────────
  logSection('Step 3 — Solve CAPTCHA')
  log('Waiting for CAPTCHA to appear…')

  // Wait up to 10s for a captcha image to be visible before solving
  try {
    await page.waitForSelector('img[src*="aptcha" i], img[id*="aptcha" i]', {
      state: 'visible',
      timeout: 10000,
    })
    log('CAPTCHA image found.')
  } catch {
    log('⚠️  CAPTCHA image not detected yet — attempting solve anyway')
  }

  const captchaFilled = await solveAndFillCaptcha(page, apiKey)
  if (!captchaFilled) log('⚠️  Could not fill CAPTCHA input — agent will handle it')

  // ── Step 4: Click "Start an Application" (retry if CAPTCHA was wrong) ────────
  logSection('Step 4 — Start an Application')
  for (let captchaAttempt = 1; captchaAttempt <= 5; captchaAttempt++) {
    log(`Clicking "Start an Application"… (attempt ${captchaAttempt})`)
    const clicked = await clickStartApplication(page)
    if (!clicked) log('⚠️  Could not find "Start an Application" button')

    await safeLoad(page, 'domcontentloaded', 15000)
    await waitForHumanBotVerification(page)
    await safeWait(page, 1500)

    // Check if we navigated away from the landing page
    const urlAfter = page.url()
    log(`URL after click: ${urlAfter}`)
    if (!urlAfter.includes('Default.aspx')) {
      log('✅ Navigation successful — CAPTCHA was accepted')
      log('Waiting for Application ID banner…')
      await appIdTracker.wait(page, 3_000)
      break
    }

    // Still on Default.aspx — either Cloudflare or a rejected image CAPTCHA.
    if (await pageLooksLikeCloudflareChallenge(page)) {
      await waitForHumanBotVerification(page)
      continue
    }
    log(`⚠️  Still on Default.aspx — CAPTCHA was wrong, re-solving… (attempt ${captchaAttempt}/5)`)
    if (captchaAttempt < 5) {
      await solveAndFillCaptcha(page, apiKey)
      await safeWait(page, 500)
    }
  }

  // ── Step 5: I Agree ──────────────────────────────────────────────────────────
  logSection('Step 5 — I Agree')
  log(`Current URL: ${page.url()}`)
  await appIdTracker.capture(page)
  if (page.url().includes('Default.aspx')) {
    log('⚠️  Still on Default.aspx — skipping I Agree step')
  } else {
  log('Checking "I agree"…')
  try {
    const agreeCheckbox = page
      .locator('input[type="checkbox"]')
      .filter({ hasText: '' })
      .first()
    // Try by label text
    // Short 3s timeout per attempt — avoids 30s default × 3 labels = 90s hang
    const labels = ['I have read', 'I agree', 'agree']
    let checked = false
    for (const lbl of labels) {
      try {
        await page.getByLabel(lbl, { exact: false }).check({ timeout: 3000 })
        checked = true
        log(`✅ "I agree" checked via label: "${lbl}"`)
        break
      } catch { /* try next */ }
    }
    if (!checked) {
      // Try known DS-160 checkbox IDs
      const knownSelectors = [
        'input[id*="chkAgree"]',
        'input[id*="cbAgree"]',
        'input[id*="Agree"]',
        'input[type="checkbox"]',
      ]
      for (const sel of knownSelectors) {
        try {
          const cb = page.locator(sel).first()
          await cb.waitFor({ state: 'visible', timeout: 3000 })
          await cb.check()
          checked = true
          log(`✅ "I agree" checked via selector: "${sel}"`)
          break
        } catch { /* try next */ }
      }
    }
    if (!checked) log('⚠️  Could not find "I agree" checkbox — agent will handle it')
  } catch {
    log('⚠️  Could not find "I agree" checkbox — agent will handle it')
  }
  } // end else (not on Default.aspx)

  await safeLoad(page, 'domcontentloaded', 10000)
  await safeWait(page, 1000)

  // ── Step 6: Security Question ────────────────────────────────────────────────
  logSection('Step 6 — Security Question')
  await appIdTracker.capture(page)
  log('Setting security question…')
  const targetQuestion = DS160_SECURITY_QUESTION
  const securityAnswer = DS160_SECURITY_ANSWER

  try {
    // Find the security question dropdown
    const sqSelectors = [
      'select[name*="SecurityQuestion"]',
      'select[id*="SecurityQuestion"]',
      'select[id*="ddlQuestions"]',
      'select',
    ]
    let questionSet = false
    const normalizedTargetQuestion = normalizeSecurityQuestion(targetQuestion)
    for (const sel of sqSelectors) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'visible', timeout: 5000 })
        const options = await el.locator('option').all()
        for (const opt of options) {
          const optionText = (await opt.textContent()) || ''
          if (normalizeSecurityQuestion(optionText) === normalizedTargetQuestion) {
            const val = await opt.getAttribute('value')
            if (val) {
              await el.selectOption(val)
              const selectedText = await el.locator('option:checked').textContent()
              questionSet =
                normalizeSecurityQuestion(selectedText || '') === normalizedTargetQuestion
              break
            }
          }
        }
        if (questionSet) break
      } catch { /* try next */ }
    }
    if (!questionSet) {
      throw new Error(`Could not select and verify exact security question: "${targetQuestion}"`)
    } else {
      log(`✅ Security question selected and verified: "${targetQuestion}"`)
    }

    // Fill security answer
    const answerSelectors = [
      'input[name*="SecurityAnswer"]',
      'input[id*="SecurityAnswer"]',
      'input[id*="txtAnswer"]',
      'input[type="text"]',
    ]
    let answerFilled = false
    for (const sel of answerSelectors) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'visible', timeout: 3000 })
        await el.fill(securityAnswer)
        answerFilled = true
        break
      } catch { /* try next */ }
    }
    if (!answerFilled) {
      log('⚠️  Could not fill security answer — agent will handle it')
    } else {
      log(`Security answer filled: "${securityAnswer}"`)
    }
  } catch (err) {
    log(`❌ Security question setup error: ${err.message}`)
    throw err
  }

  // Click Continue / Next to proceed past the security question page
  try {
    await safeLoad(page, 'domcontentloaded', 5000)
    await safeWait(page, 1000)
    const nextBtn = page.getByRole('button', { name: /continue|next|ok/i })
    if (await nextBtn.isVisible({ timeout: 3000 })) {
      await nextBtn.click()
      await safeLoad(page, 'domcontentloaded', 10000)
      await safeWait(page, 1500)
      await appIdTracker.capture(page)
    }
  } catch { /* agent handles remaining navigation */ }

  // The agent will land on "Apply For a Nonimmigrant Visa" page which has
  // the embassy dropdown again — select it explicitly before handing to agent.
  logSection('Apply For a Nonimmigrant Visa — Embassy Dropdown')
  try {
    await safeWait(page, 2000)
    // Try all select elements and pick any option containing "Tel Aviv"
    const selects = await page.locator('select').all()
    for (const sel of selects) {
      try {
        const opts = await sel.locator('option').all()
        for (const opt of opts) {
          const txt = await opt.textContent()
          if (txt && txt.includes('Tel Aviv')) {
            const val = await opt.getAttribute('value')
            if (val) {
              await sel.selectOption(val)
              log('Embassy dropdown selected: Tel Aviv')
              await safeLoad(page, 'domcontentloaded', 10000)
              await safeWait(page, 1500)
              // Click Next if visible
              try {
                const next = page.getByRole('button', { name: /next/i })
                if (await next.isVisible({ timeout: 2000 })) {
                  await next.click()
                  await safeLoad(page, 'domcontentloaded', 10000)
                  await safeWait(page, 1500)
                }
              } catch { /* agent handles */ }
              break
            }
          }
        }
      } catch { /* try next select */ }
    }
  } catch (err) {
    log(`⚠️  Embassy dropdown on form page: ${err.message} — agent will handle`)
  }

  await appIdTracker.capture(page)
  log('Initial setup complete — handing over to agent loop.')
  return appIdTracker.get()
}

/**
 * Continue an existing DS-160 via "Retrieve an Application".
 * Needs Application ID + first 5 letters of surname + birth year + security answer.
 * Lands on the last completed page; agent continues from there.
 */
async function retrieveApplication(page, apiKey, { appId, surname5, birthYear, securityAnswer }, appIdTracker = createAppIdTracker(appId)) {
  logSection('Retrieve — Navigate to DS-160')
  log(`Retrieving application ${appId} (surname=${surname5}, yob=${birthYear})…`)
  await openCeacLanding(page)

  logSection('Retrieve — Select Embassy Location')
  let locationSelected = false
  try {
    const knownIds = [
      '#ctl00_SiteContentPlaceHolder_ucLocationSearch_ddlLocation',
      'select[id$="ddlLocation"]',
      'select[name$="ddlLocation"]',
    ]
    let ddl = null
    for (const sel of knownIds) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'visible', timeout: 3000 })
        ddl = el
        break
      } catch { /* try next */ }
    }
    if (!ddl) {
      const allSelects = await page.locator('select').all()
      for (const sel of allSelects) {
        const texts = await Promise.all(
          (await sel.locator('option').all()).slice(0, 3).map((o) => o.textContent()),
        )
        const isLanguage = texts.some(
          (t) => t && (t.includes('Arabic') || t.includes('Hebrew') || t.includes('Français') || t.includes('العربية')),
        )
        if (!isLanguage) {
          ddl = sel
          break
        }
      }
    }
    if (ddl) {
      const options = await ddl.locator('option').all()
      for (const opt of options) {
        const txt = (await opt.textContent())?.trim() || ''
        if (txt.includes('Tel Aviv') || txt.includes('TEL AVIV')) {
          const val = await opt.getAttribute('value')
          if (val) {
            await ddl.selectOption(val)
            locationSelected = true
            log(`✅ Embassy selected: "${txt}"`)
            await safeWait(page, 1500)
            break
          }
        }
      }
    }
  } catch (err) {
    log(`⚠️  Embassy dropdown error: ${err.message}`)
  }
  if (!locationSelected) log('⚠️  Embassy not selected — continuing anyway')

  logSection('Retrieve — Solve CAPTCHA')
  try {
    await page.waitForSelector('img[src*="aptcha" i], img[id*="aptcha" i]', {
      state: 'visible',
      timeout: 10000,
    })
  } catch {
    log('⚠️  CAPTCHA image not detected yet — attempting solve anyway')
  }

  await solveAndFillCaptcha(page, apiKey)

  logSection('Retrieve — Click Retrieve an Application')

  // CEAC renders this control as a link on some pages and as a submit input on
  // others, so match every form. Clicking by text alone is not enough: the same
  // words appear in the instructions above it, and clicking a paragraph silently
  // does nothing while looking like a successful click.
  const retrieveControl = () =>
    page
      .getByRole('button', { name: /retrieve an application/i })
      .or(page.getByRole('link', { name: /retrieve an application/i }))
      .or(page.locator(
        'input[type="submit"][value*="Retrieve an Application" i], ' +
        'input[type="button"][value*="Retrieve an Application" i]',
      ))
      .first()

  const captchaStillThere = () => captchaPromptVisible(page)

  /**
   * Whether we actually reached the credential form. This has to be a positive
   * test: inferring it from the landing page's captcha box having disappeared
   * reports success for any bounce or reset too, and the run then spends minutes
   * hunting for fields that were never there.
   */
  const onRetrieveForm = async () =>
    isRecoveryPage(page) ||
    isInsideDs160Application(page) ||
    (await page
      .locator(
        'input[id*="ApplicationID" i], input[name*="ApplicationID" i], ' +
        'input[id*="AppId" i], input[name*="AppId" i]',
      )
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false))

  for (let captchaAttempt = 1; captchaAttempt <= 5; captchaAttempt++) {
    log(`Clicking "Retrieve an Application"… (attempt ${captchaAttempt})`)
    const clicked = await retrieveControl()
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    if (!clicked) log('⚠️  Could not find the "Retrieve an Application" control')

    await safeLoad(page, 'domcontentloaded', 15000)
    await waitForHumanBotVerification(page)
    await safeWait(page, 1500)

    log(`URL after click: ${page.url()}`)
    if (await onRetrieveForm()) {
      log('✅ Reached the retrieve form — CAPTCHA accepted')
      break
    }

    if (await pageLooksLikeCloudflareChallenge(page)) {
      await waitForHumanBotVerification(page)
      continue
    }

    // A visible image or input means CEAC rejected the answer and issued a new one.
    if (!(await captchaStillThere())) {
      log(`⚠️  Not on the retrieve form and no CAPTCHA present at ${page.url()}`)
      break
    }

    log(`⚠️  Still on landing page — CAPTCHA was wrong, re-solving… (${captchaAttempt}/5)`)
    if (captchaAttempt < 5) {
      await solveAndFillCaptcha(page, apiKey)
      await safeWait(page, 500)
    }
  }

  // Fail here rather than in the credential loop below: that loop would burn
  // four passes of selector timeouts before reporting the same thing, and its
  // message points at the credentials instead of at this step.
  if (!(await onRetrieveForm())) {
    throw new Error(
      `Could not open the retrieve form. Still at ${page.url()} after 5 CAPTCHA attempts ` +
      `(retrieve control found: ${(await retrieveControl().count().catch(() => 0)) > 0}, ` +
      `CAPTCHA present: ${await captchaStillThere()}).`,
    )
  }

  logSection('Retrieve — Enter Application Credentials')

  async function clickRetrieveSubmit() {
    try {
      await page.getByRole('button', { name: /^retrieve application$/i }).click({ timeout: 4000 })
      return true
    } catch {
      try {
        await page.locator('input[type="submit"][value*="Retrieve Application" i]').first().click({ timeout: 4000 })
        return true
      } catch {
        try {
          await page.getByRole('button', { name: /retrieve application/i }).click({ timeout: 4000 })
          return true
        } catch {
          return false
        }
      }
    }
  }

  async function fillSecurityQuestionsPage() {
    const question = await readVisibleSecurityQuestion(page)
    if (question) log(`Security question on page: "${question}"`)
    log(`Using security answer from fill prompt/applicant data: "${securityAnswer}"`)

    // Dedicated retrieve: named CEAC fields first, then row labels, then order fallback.
    let filledSurname =
      (await fillFirstVisible(
        page,
        ['input[id*="Surname" i]', 'input[name*="Surname" i]', 'input[id*="LastName" i]'],
        surname5,
        'Surname',
      )) ||
      (await fillRecoveryFieldByRowLabel(page, /First 5 letters of Surname/i, surname5, 'Surname'))

    let filledYear =
      (await fillFirstVisible(
        page,
        [
          'input[id*="DOBYear" i]',
          'input[name*="DOBYear" i]',
          'input[id*="YearOfBirth" i]',
          'input[name*="YearOfBirth" i]',
          'input[id*="BirthYear" i]',
          'input[name*="BirthYear" i]',
          'input[id*="Year" i][maxlength="4"]',
          'input[name*="Year" i][maxlength="4"]',
        ],
        birthYear,
        'Year of Birth',
      )) ||
      (await fillRecoveryFieldByRowLabel(page, /Year of Birth/i, birthYear, 'Year of Birth'))

    let filledAnswer =
      (await fillFirstVisible(
        page,
        [
          'input[id*="SecurityAnswer" i]',
          'input[name*="SecurityAnswer" i]',
          'input[id*="Answer" i]',
          'input[name*="Answer" i]',
          'input[id*="txtAnswer" i]',
        ],
        securityAnswer,
        'Security Answer',
      )) ||
      (await fillRecoveryFieldByRowLabel(
        page,
        /Security Question|family used to call|home phone|child\?/i,
        securityAnswer,
        'Security Answer',
      ))

    let answerOnPage = true
    if (!filledSurname || !filledYear || !filledAnswer) {
      const ordered = await fillRecoverySecurityByEditableOrder(page, {
        surname5,
        birthYear,
        securityAnswer,
      })
      filledSurname = filledSurname || ordered.filledSurname
      filledYear = filledYear || ordered.filledYear
      filledAnswer = filledAnswer || ordered.filledAnswer
      answerOnPage = ordered.answerOnPage
    }

    if (!retrieveSecurityReady({ filledSurname, filledYear, filledAnswer, answerOnPage })) {
      throw new Error(
        `Could not fill retrieve security fields (surname=${filledSurname}, yob=${filledYear}, answer=${filledAnswer}, answerOnPage=${answerOnPage}).`,
      )
    }
    if (!filledAnswer) {
      log('No security-answer field on this retrieve page — submitting surname and year of birth.')
    }
    return true
  }

  // Dedicated two-step retrieve: Application ID page, then surname/YOB/answer page.
  for (let step = 1; step <= 4; step++) {
    await throwIfApplicationAlreadySubmitted(page)
    if (isInsideDs160Application(page) && !(await retrieveChallengeStillShowing(page))) {
      log('✅ Inside DS-160 application — retrieve complete.')
      break
    }

    log(`Credential fill pass ${step}… URL=${page.url()}`)
    if (await captchaPromptVisible(page)) {
      log('Retrieve page is asking for the code shown in the image — solving it the same way as a new application.')
      let captchaFilled = false
      for (let captchaTry = 1; captchaTry <= 3 && !captchaFilled; captchaTry++) {
        captchaFilled = await solveAndFillCaptcha(page, apiKey)
      }
      if (!captchaFilled) {
        log('⚠️  Retrieve CAPTCHA is on the page but the code box was not filled — not submitting yet')
        continue
      }
    }
    const kind = await recoveryPageKind(page)
    log(`Recovery step: ${kind}`)

    if (kind === 'security' || kind === 'combined') {
      if (kind === 'combined') await fillRecoveryApplicationId(page, appId)
      await fillSecurityQuestionsPage()
    } else {
      const filledId = await fillRecoveryApplicationId(page, appId)
      if (!filledId) log('⚠️  Application ID field not filled this pass')
    }

    const clicked = await clickRetrieveSubmit()
    if (!clicked) {
      log('⚠️  Retrieve submit button not found this pass')
    } else {
      await safeLoad(page, 'domcontentloaded', 15000)
      await safeWait(page, 2000)
      log(`URL after retrieve submit: ${page.url()}`)
    }
    await throwIfApplicationAlreadySubmitted(page)

    if (isInsideDs160Application(page) && !(await retrieveChallengeStillShowing(page))) {
      log('✅ Application retrieved — handing over to agent loop.')
      await appIdTracker.wait(page, 5_000)
      break
    }
    if (await codeAsShownVisible(page)) {
      log('Still on the retrieve page — the image code was missing or rejected. Solving it again.')
    }

    if (isRecoveryPage(page) && step >= 3 && kind === 'security') {
      const errText = await page.locator('.error, .validation-summary, #ctl00_SiteContentPlaceHolder_lblError, span[style*="red"]').allTextContents().catch(() => [])
      throw new Error(
        `Still on Recovery.aspx after security submit. Check surname/YOB/security answer.` +
          (errText?.length ? ` Page errors: ${errText.join(' | ')}` : ''),
      )
    }
  }

  await throwIfApplicationAlreadySubmitted(page)
  if (!isInsideDs160Application(page) || await retrieveChallengeStillShowing(page)) {
    throw new Error(`Retrieve did not reach a DS-160 form page. Current URL: ${page.url()}`)
  }

  await appIdTracker.capture(page)
  log('Retrieve setup complete — handing over to agent loop.')
  return appIdTracker.get()
}

// Clicking Exit does not leave the application: it opens a confirmation modal,
// and on pages with unsaved edits a save prompt before that. Those confirm
// buttons are CSS image buttons whose value attribute is empty on some
// renderings, so they are addressed by their stable ASP.NET ids — a text- or
// role-based locator finds the Exit link but never the button that completes it.
const EXIT_LINK_SELECTOR = '#ctl00_lbtnExit'
const SAVE_PROMPT_SELECTOR = '#ctl00_pnlSaveWarning'
const SAVE_CONFIRM_SELECTOR = '#ctl00_btnOkWarning'
const EXIT_PROMPT_SELECTOR = '#ctl00_pnlExitWarning'
const EXIT_CONFIRM_SELECTOR = '#ctl00_btnClientExit'

/** Answer the save and exit confirmation modals, if CEAC raised them. */
async function confirmExitPrompts(page) {
  const prompts = [
    { panel: SAVE_PROMPT_SELECTOR, confirm: SAVE_CONFIRM_SELECTOR, what: 'save' },
    { panel: EXIT_PROMPT_SELECTOR, confirm: EXIT_CONFIRM_SELECTOR, what: 'exit' },
  ]
  for (const { panel, confirm, what } of prompts) {
    const shown = await page
      .locator(panel)
      .isVisible({ timeout: 3000 })
      .catch(() => false)
    if (!shown) continue
    log(`Confirming the ${what} prompt…`)
    await page.locator(confirm).first().click({ timeout: 5000 }).catch(() => {})
    await safeLoad(page, 'domcontentloaded', 10_000)
    await safeWait(page, 1000)
  }
}

/**
 * Leave the application the way the site expects: save the current page, then
 * exit and confirm.
 *
 * Tearing the browser down instead leaves CEAC holding the application open, so
 * the retry's retrieve cannot reopen it — which is why a retry failed where
 * running the retrieve on its own minutes later succeeded. It also drops
 * whatever the failed attempt had entered on the current page.
 *
 * Best effort by design: this runs while another failure is already being
 * handled, so it reports what happened and never throws.
 */
async function leaveApplicationCleanly(page) {
  if (!page || page.isClosed() || !isInsideDs160Application(page)) return false
  try {
    const exitLink = page.locator(EXIT_LINK_SELECTOR).first()
    const present = await exitLink.isVisible({ timeout: 3000 }).catch(() => false)
    if (!present) {
      log('⚠️  No Exit control on the page — leaving the session for CEAC to time out')
      return false
    }
    await exitLink.click({ timeout: 5000 })
    await safeWait(page, 1000)
    await confirmExitPrompts(page)
    log(`Saved and exited the application (now at ${page.url()})`)
    return true
  } catch (err) {
    log(`⚠️  Could not exit cleanly (${err.message}) — leaving the session for CEAC to time out`)
    return false
  }
}

async function exitApplication(page) {
  if (!page || page.isClosed()) return false
  const exitControl = page
    .locator(EXIT_LINK_SELECTOR)
    .or(page.getByRole('button', { name: /^Exit Application$/i }))
    .or(page.getByRole('link', { name: /^Exit(?: Application)?$/i }))
    .or(page.locator('input[type="submit"][value*="Exit" i], input[type="button"][value*="Exit" i]'))
    .first()
  const visible = await exitControl
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => true)
    .catch(() => false)
  if (!visible) {
    log('No CEAC Exit control after submission — closing the fill tab instead.')
    return false
  }

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}),
    exitControl.click(),
  ])
  await confirmExitPrompts(page)
  log('Exited the CEAC application.')
  return true
}

export function isCeacFillTabUrl(url = '') {
  return /ceac\.state\.gov/i.test(String(url || ''))
}

/** Close CEAC fill tabs only — never the employee's other Chrome windows. */
export async function closeCeacFillTabs(context) {
  if (!context?.pages) return 0
  const pages = context.pages()
  let closed = 0
  for (const tab of pages) {
    if (tab.isClosed?.()) continue
    const url = tab.url() || ''
    if (!isCeacFillTabUrl(url)) continue
    try {
      await tab.close()
      closed += 1
      log(`Closed fill tab: ${url}`)
    } catch (err) {
      logWarn(`Could not close fill tab ${url}: ${err.message}`)
    }
  }
  return closed
}

/**
 * After a stall or dead tab, do not keep driving the stuck page.
 * Try a short Exit, then close the CEAC tab so the next attempt can retrieve.
 */
export async function abandonStuckFill(page, context, { reason = 'stuck session' } = {}) {
  log(`Abandoning ${reason} — closing the CEAC tab and retrieving instead of continuing here.`)
  try {
    await withTimeout(leaveApplicationCleanly(page), 6_000)
  } catch {
    /* page may already be dead */
  }
  try {
    await withTimeout(closeCeacFillTabs(context), 5_000)
  } catch {
    /* tab close is best-effort */
  }
}

async function settleBeforeRetrieve({ stalled = false, page } = {}) {
  const waitMs = stalled ? STALL_SESSION_RELEASE_MS : SESSION_RELEASE_MS
  if (page && !page.isClosed?.()) {
    await safeWait(page, waitMs)
    return
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs))
}

function defaultChromeUserDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/Google/Chrome')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
  }
  return path.join(os.homedir(), '.config', 'google-chrome')
}

function isolatedChromeEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.DS160_ISOLATED_CHROME || '').trim())
}

function macFrontmostApp() {
  if (process.platform !== 'darwin') return ''
  const result = spawnSync(
    'osascript',
    ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
    { encoding: 'utf8' },
  )
  return (result.stdout || '').trim()
}

function macActivateApp(name) {
  if (!name || process.platform !== 'darwin') return
  spawnSync('osascript', ['-e', `tell application ${JSON.stringify(name)} to activate`], {
    stdio: 'ignore',
  })
}

function isolatedChromeProfileDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/DS160-Fill-Chrome')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DS160-Fill-Chrome')
  }
  return path.join(os.homedir(), '.ds160-fill-chrome')
}

function chromeProfileDir() {
  const fromEnv = process.env.DS160_CHROME_PROFILE?.trim()
  if (fromEnv) return fromEnv
  if (isolatedChromeEnabled()) return isolatedChromeProfileDir()
  return defaultChromeUserDataDir()
}

function googleChromeIsRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return /chrome\.exe/i.test(out)
    }
    execSync('pgrep -x "Google Chrome"', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function chromeDebugHint() {
  if (process.platform === 'win32') {
    return '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222'
  }
  return '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222'
}

const CHROME_LAUNCH_OPTS = {
  viewport: { width: 1280, height: 900 },
  chromiumSandbox: true,
  ignoreDefaultArgs: ['--no-sandbox'],
  // Stop Chrome from popping "Save address?" over CEAC after street/city/ZIP fills.
  args: [
    '--disable-features=AutofillServerCommunication,AutofillEnableAccountWalletStorage',
  ],
}

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222'

async function logBrowserIdentity(page) {
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => '')
  log(`Browser user-agent: ${ua || '(unavailable)'}`)
}

async function connectOverCdp(appIdTracker, cdpUrl) {
  log(`Attaching to the Chrome you already opened (${cdpUrl})`)
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0]
  if (!context) {
    throw new Error(
      `No browser context on ${cdpUrl}. Quit Chrome, then start it with --remote-debugging-port=9222, pass Cloudflare there, and rerun.`,
    )
  }
  const ceacPage = context.pages().find((p) => /ceac\.state\.gov/i.test(p.url() || ''))
  const page = ceacPage || context.pages()[0] || await context.newPage()
  if (ceacPage) log(`Using existing CEAC tab: ${ceacPage.url()}`)
  attachSessionLogging(page, context, appIdTracker)
  process.env.DS160_CDP_URL = cdpUrl
  await logBrowserIdentity(page)
  return {
    context,
    page,
    close: async () => {
      try { browser.disconnect() } catch { /* already disconnected */ }
    },
  }
}

async function launchPersistentContext(headed) {
  const profileDir = chromeProfileDir()
  const isolated = isolatedChromeEnabled()
  const launchOpts = {
    ...CHROME_LAUNCH_OPTS,
    headless: !headed,
    slowMo: headed ? 50 : 0,
    ignoreDefaultArgs: [
      ...(CHROME_LAUNCH_OPTS.ignoreDefaultArgs || []),
      ...(isolated ? ['--enable-automation'] : []),
    ],
    ...(isolated
      ? {
          args: [
            ...(CHROME_LAUNCH_OPTS.args || []),
            '--disable-blink-features=AutomationControlled',
          ],
        }
      : {}),
  }
  if (!headed) {
    logWarn(
      'Headless Chromium almost never passes Cloudflare on CEAC. Run with DS160_HEADED=1 and click Turnstile in the window.',
    )
  }

  const preferChrome = process.env.DS160_PLAYWRIGHT_CHROMIUM !== '1'
  if (preferChrome) {
    try {
      log(`Launching Google Chrome (${headed ? 'headed' : 'headless'}), profile=${profileDir}`)
      return await chromium.launchPersistentContext(profileDir, {
        ...launchOpts,
        channel: 'chrome',
      })
    } catch (err) {
      logWarn(`Google Chrome channel unavailable (${err.message}) — using Playwright Chromium`)
    }
  }

  log(`Launching Playwright Chromium (${headed ? 'headed' : 'headless'}), profile=${profileDir}`)
  return chromium.launchPersistentContext(profileDir, launchOpts)
}

function stopIsolatedFillChrome() {
  if (process.platform === 'win32') return
  const profile = chromeProfileDir()
  if (!profile) return
  try {
    spawnSync('pkill', ['-f', profile], { stdio: 'ignore' })
  } catch { /* none running */ }
}

async function launchIsolatedChrome(appIdTracker) {
  const profileDir = chromeProfileDir()
  const previousApp = macFrontmostApp()
  log(`Opening a separate fill Chrome. profile=${profileDir}`)
  stopIsolatedFillChrome()
  await new Promise((resolve) => setTimeout(resolve, 800))
  let context
  try {
    context = await launchPersistentContext(true)
  } catch (err) {
    logWarn(`Fill Chrome did not start (${err.message.split('\n')[0]}) — retrying after closing leftovers`)
    stopIsolatedFillChrome()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    context = await launchPersistentContext(true)
  }
  const page = context.pages()[0] || await context.newPage()
  attachSessionLogging(page, context, appIdTracker)
  await logBrowserIdentity(page)
  if (previousApp && !/^google chrome$/i.test(previousApp)) macActivateApp(previousApp)
  return {
    context,
    page,
    close: async () => {
      try { await context.close() } catch { /* already closed */ }
      stopIsolatedFillChrome()
    },
  }
}

async function launchSession(headed, appIdTracker) {
  if (isolatedChromeEnabled()) {
    return launchIsolatedChrome(appIdTracker)
  }

  const cdpUrl = process.env.DS160_CDP_URL?.trim() || DEFAULT_CDP_URL
  try {
    return await connectOverCdp(appIdTracker, cdpUrl)
  } catch (err) {
    if (process.env.DS160_CDP_URL?.trim()) throw err
    logWarn(`Could not attach to Chrome at ${cdpUrl} (${err.message.split('\n')[0]})`)
  }

  if (googleChromeIsRunning()) {
    throw new Error(
      'Google Chrome is already running, but not on port 9222, so autofill cannot reuse the session that passed Cloudflare. ' +
      `Quit Chrome, then either start ${chromeDebugHint()} and rerun, or quit Chrome and rerun so autofill can open your real Chrome profile.`,
    )
  }

  const context = await launchPersistentContext(headed)
  const page = context.pages()[0] || await context.newPage()
  attachSessionLogging(page, context, appIdTracker)
  await logBrowserIdentity(page)
  return {
    context,
    page,
    close: async () => {
      try { await context.close() } catch { /* already closed */ }
    },
  }
}

function attachSessionLogging(page, context, appIdTracker) {
  context.addInitScript(disarmCeacUnloadInPage).catch(() => {})
  disarmCeacUnload(page).catch(() => {})
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    disarmCeacUnload(page).catch(() => {})
    log(`↪ Navigated to: ${frame.url()}`)
    appIdTracker?.capture(page).catch(() => {})
  })
  page.on('pageerror', (err) => logError('Page JS error', err))
  page.on('close', () => log('⚠️  PAGE CLOSED (browser window was closed or tab crashed)'))
  page.on('crash', () => log('💥 PAGE CRASHED'))
  context.on('close', () => log('⚠️  BROWSER CONTEXT CLOSED'))
}

async function resetSession({ close, headed, appIdTracker }) {
  await withTimeout(Promise.resolve().then(() => close?.()), 8_000)
  return launchSession(headed, appIdTracker)
}

async function saveRunScreenshot(page) {
  try {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return
    const dir = path.join(REPO_ROOT, 'autofill-output', 'shots')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `run-${Date.now()}.jpg`)
    await page.screenshot({ path: file, type: 'jpeg', quality: 55, fullPage: false })
    log(`RUN_SCREENSHOT: ${file}`)
  } catch {
    /* a missing screenshot should not fail the fill */
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const {
    inputFile,
    formId: cliFormId,
    retrieve,
    fresh,
    appId: cliAppId,
    surname,
    birthYear,
    securityAnswer,
    securityAnswerExplicit,
  } = parseArgs()
  const { text: translatedText, embeddedFormId, answerSheet } = readTranslatedText(inputFile)
  const formId = cliFormId || embeddedFormId
  if (!formId) {
    if (retrieve) {
      log('⚠️  No --form-id / embedded DS160_FORM_ID — DS-160 PDF saving will be skipped.')
    } else {
      console.error(
        'Applicant form UUID is missing. Download a new translated file or pass --form-id <uuid>.',
      )
      process.exit(1)
    }
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set. Add it to your .env file.')
    process.exit(1)
  }

  const headed = process.env.DS160_HEADED === '1'
  const inputResolved = path.resolve(inputFile)
  const storedAppId = lookupApplicationId(REPO_ROOT, {
    filePath: inputResolved,
    name: path.basename(inputResolved),
    formId,
  })
  const initialAppId = fresh ? '' : (cliAppId || storedAppId)
  const startWithRetrieve = !fresh && Boolean(retrieve || initialAppId)
  if (fresh) {
    log(storedAppId
      ? `Starting a new application — not retrieving stored Application ID ${storedAppId}`
      : 'Starting a new application')
  } else if (storedAppId && !cliAppId) {
    log(`Resuming stored Application ID ${storedAppId}`)
  }

  const retrieveCredsBase = extractRetrieveCredentials(
    translatedText,
    { surname, birthYear, securityAnswer, securityAnswerExplicit },
    { required: retrieve && !initialAppId },
  )

  let personal1Saved = Boolean(initialAppId)
  const persistAppId = (id) => {
    if (!personal1Saved) return
    rememberApplicationId(REPO_ROOT, {
      filePath: inputResolved,
      name: path.basename(inputResolved),
      formId,
      appId: id,
      personal1Saved: true,
    })
  }
  const markPersonal1Saved = () => {
    personal1Saved = true
    const id = appIdTracker.get()
    if (id) log(`PERSONAL1_SAVED DS160_APPLICATION_ID=${id}`)
    else log('PERSONAL1_SAVED')
    if (id) persistAppId(id)
  }
  const appIdTracker = createAppIdTracker(initialAppId, { onChange: persistAppId })
  if (personal1Saved && appIdTracker.get()) persistAppId(appIdTracker.get())
  let { context, page, close } = await launchSession(headed, appIdTracker)
  let lastError = null
  let closeFillTabsAtEnd = false

  try {
    let attempt = 0
    let maxAttempts = MAX_FILL_ATTEMPTS
    let retrieveFailures = 0
    while (attempt < maxAttempts) {
      if (fillAborted) {
        log('Stopped by user — not retrying.')
        lastError = lastError || new Error('Stopped by user')
        process.exitCode = 130
        break
      }
      attempt += 1
      const isRetry = attempt > 1
      const startingFresh = retrieveFailures >= MAX_RETRIEVE_FAILURES_BEFORE_FRESH
      if (startingFresh) {
        log('Retrieve failed 2 times — starting this application from the beginning.')
        appIdTracker.forget()
        personal1Saved = false
        retrieveFailures = 0
      }
      const appId = appIdTracker.get()
      if (isRetry) {
        logSection(`Retry ${attempt - 1}/${maxAttempts - 1} after failure`)
      } else {
        logSection('Starting autofill')
      }
      if (appId) log(`Using Application ID ${appId}`)

      let retrieveThrew = false
      try {
        const mode = nextAttemptMode(attempt, {
          startWithRetrieve: startingFresh ? false : startWithRetrieve,
          appId,
          personal1Saved,
          retrieveFailures,
        })
        if (mode === 'retrieve' && appId && retrieveCredsBase) {
          try {
            await retrieveApplication(page, apiKey, { appId, ...retrieveCredsBase }, appIdTracker)
          } catch (retrieveErr) {
            retrieveThrew = true
            throw retrieveErr
          }
        } else {
          if (mode === 'retrieve') {
            log('⚠️  Cannot retrieve (missing Application ID or credentials) — starting a new application')
          }
          await setupApplication(page, apiKey, appIdTracker, { fresh: startingFresh || (fresh && attempt === 1) })
        }

        if (!appIdTracker.get()) await appIdTracker.wait(page, 3_000)
        if (appIdTracker.get()) persistAppId(appIdTracker.get())
        const result = await runAgent(page, translatedText, apiKey, {
          answerSheet,
          onPersonal1Saved: markPersonal1Saved,
        })
        const outcome = result?.outcome || 'review'
        lastError = null

        if (outcome !== 'submitted') {
          log(
            outcome === 'blocked'
              ? 'Autofill stopped at the submission boundary. Form is NOT submitted.'
              : 'Autofill stopped before submit and PDF save.',
          )
          if (appIdTracker.get()) log(`Application ID for later retrieve: ${appIdTracker.get()}`)
          break
        }

        // Fill already succeeded — PDF upload / exit must not trigger a retrieve retry.
        closeFillTabsAtEnd = true
        let pdfsSaved = false
        try {
          if (formId) {
            await saveConfirmationPdf(page, formId, log, { translatedText })
          } else {
            log('Skipped DS-160 PDF saves (no form UUID).')
          }
          pdfsSaved = true
        } catch (postErr) {
          logError('Post-submit PDF save failed — application was already submitted, not retrying fill', postErr)
          process.exitCode = 1
        }
        try {
          await exitApplication(page)
        } catch (exitErr) {
          logWarn(`Could not click CEAC Exit after submission (${exitErr.message}) — closing the fill tab instead.`)
        }
        if (pdfsSaved) {
          log('')
          log('════════════════════════════════════════════════════')
          log('✅  APPLICATION SUBMITTED — CONFIRMATION + FULL APPLICATION SAVED')
          log('════════════════════════════════════════════════════')
          log('Review the local confirmation and full Print Application PDFs.')
        }
        break
      } catch (err) {
        if (page && !page.isClosed()) {
          await appIdTracker.capture(page).catch(() => '')
        }
        if (appIdTracker.get()) persistAppId(appIdTracker.get())
        if (isApplicationAlreadySubmittedError(err)) {
          log(
            'APPLICATION_ALREADY_SUBMITTED — CEAC says this application is already submitted. ' +
            'Stopping this applicant; not retrying and not creating a new application.',
          )
          lastError = null
          closeFillTabsAtEnd = true
          log('')
          log('════════════════════════════════════════════════════')
          log('✅  APPLICATION SUBMITTED — already submitted at CEAC')
          log('════════════════════════════════════════════════════')
          break
        }
        lastError = err
        logError(isRetry ? `Retry ${attempt - 1} failed` : 'Autofill failed', err)
        const hasAppId = Boolean(appIdTracker.get())
        const stalled = isStallError(err)
        const stuck = isStuckSessionError(err)
        if (fillAborted || !shouldRetryFillAfterError(err, { hasAppId })) {
          log(
            fillAborted
              ? 'Stopped by user — not retrying.'
              : isFatalCloudflareError(err)
              ? 'Chrome/Cloudflare session died — not retrying (retries make the block worse).'
              : 'Browser closed with no Application ID — not retrying.',
          )
          if (fillAborted) process.exitCode = 130
          break
        }
        if (retrieveThrew) {
          retrieveFailures += 1
          if (retrieveFailures >= MAX_RETRIEVE_FAILURES_BEFORE_FRESH && attempt >= maxAttempts) {
            maxAttempts = attempt + 1
          }
        }
        const giveUpRetrieve = retrieveThrew && retrieveFailures >= MAX_RETRIEVE_FAILURES_BEFORE_FRESH
        if (isCeacServiceUnavailableError(err) || isClosedBrowserError(err)) {
          log(!giveUpRetrieve && personal1Saved
            ? 'CEAC/identix session is dead — reopening Chrome and retrieving the application.'
            : 'CEAC/identix session is dead — reopening Chrome and starting a new application.')
        }
        if (stalled) {
          log(!giveUpRetrieve && personal1Saved
            ? 'Stall — not continuing on this page. Closing the tab and retrieving with the Application ID.'
            : 'Stall — not continuing on this page. Closing the tab and starting a new application.')
        }
        if (attempt >= maxAttempts || fillAborted) {
          if (stuck) {
            try { await abandonStuckFill(page, context, { reason: stalled ? 'page stall' : 'dead tab' }) } catch { /* ignore */ }
          }
          break
        }
        const retryId = personal1Saved ? appIdTracker.get() : ''
        if (!personal1Saved && appIdTracker.get()) {
          log(`Application ID ${appIdTracker.get()} is not retrievable yet — Personal Information 1 was not saved. Starting a new application.`)
        }
        if (giveUpRetrieve) {
          log('Will start the same application from the beginning…')
        } else if (stuck || (retryId && retrieveCredsBase)) {
          if (retryId && retrieveCredsBase) {
            log(`Will retry by retrieving Application ID ${retryId} (retry ${attempt}/${maxAttempts - 1})…`)
          } else {
            log(`Will retry after closing the stuck tab (retry ${attempt}/${maxAttempts - 1})…`)
          }
          if (stuck) {
            try {
              await abandonStuckFill(page, context, { reason: stalled ? 'page stall' : 'dead tab' })
            } catch {
              log('Could not close the stuck CEAC tab — opening a fresh session.')
            }
            await settleBeforeRetrieve({ stalled, page })
          } else {
            try {
              const exited = await leaveApplicationCleanly(page)
              if (exited) await safeWait(page, SESSION_RELEASE_MS)
            } catch {
              log('Could not exit CEAC cleanly (tab already gone) — opening a fresh session.')
            }
          }
        } else {
          log(`Will retry with a new application (retry ${attempt}/${maxAttempts - 1})…`)
        }
        ;({ context, page, close } = await resetSession({ close, headed, appIdTracker }))
      }
    }

    if (lastError) {
      logError('Fatal error — no more retries', lastError)
      if (appIdTracker.get() && personal1Saved) log(`Application ID for manual retrieve: ${appIdTracker.get()}`)
      else if (appIdTracker.get()) {
        log(`Application ID ${appIdTracker.get()} was not saved for retrieve — Personal Information 1 was not completed.`)
      }
      process.exitCode = 1
    }
  } finally {
    await saveRunScreenshot(page)
    if (closeFillTabsAtEnd) {
      try { await closeCeacFillTabs(context) } catch { /* tab already gone */ }
    }
    try { await close() } catch { /* already closed */ }
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectRun) {
  process.on('SIGTERM', () => requestAbortFill('Stopped by user'))
  process.on('SIGINT', () => requestAbortFill('Stopped by user'))
  main()
}
