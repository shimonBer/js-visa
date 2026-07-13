#!/usr/bin/env node
/**
 * DS-160 DOM Snapshot Crawler
 *
 * Navigates the DS-160 form page by page (headless by default) and saves
 * full-page DOM snapshots to dom-snapshots/ so autofill logic can be tested
 * offline — no Chrome required.
 *
 * For each DS-160 page it saves TWO HTML files:
 *   dom-snapshots/{page}.html            ← clean page (no answers selected)
 *   dom-snapshots/{page}--expanded.html  ← all Yes/No radios set to "Yes"
 *                                           (reveals every conditional sub-field)
 *
 * It also writes dom-snapshots/manifest.json with page order and dropdown
 * option lists for every <select> on each page.
 *
 * Usage:
 *   node autofill/crawl-dom.js --input /path/to/translated.txt
 *   DS160_HEADED=1 node autofill/crawl-dom.js --input /path/to/translated.txt
 *
 * The translated.txt file is used to drive the agent forward through pages.
 * Dom snapshots are taken at the START of each new page, before any filling.
 */

import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'
import {
  solveCaptchaOnPage,
  askAgent,
  executeAction,
  detectAndLogSection,
  log,
  logSection,
  logError,
  logWarn,
} from './agent.js'

// ─── Config ──────────────────────────────────────────────────────────────────

const SNAPSHOTS_DIR = path.join(process.cwd(), 'dom-snapshots')
const MANIFEST_FILE = path.join(SNAPSHOTS_DIR, 'manifest.json')

// DS-160 page context key → human-readable name
const PAGE_NAMES = {
  captcha:           'Landing / CAPTCHA',
  disclaimer:        'Disclaimer',
  security_question: 'Security Question',
  personal1:         'Personal Information 1',
  personal2:         'Personal Information 2',
  travel:            'Travel Information',
  companions:        'Travel Companions',
  prev_travel:       'Previous U.S. Travel',
  address:           'Address & Phone',
  passport:          'Passport',
  contact:           'Contact People in the U.S.',
  family:            'Family Information',
  work_edu:          'Work / Education / Training',
  security:          'Security & Background',
  review:            'Review',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeWait(page, ms) {
  return page.waitForTimeout(ms).catch(() => {})
}

function safeLoad(page, state = 'domcontentloaded', timeout = 12000) {
  return page.waitForLoadState(state, { timeout }).catch(() => {})
}

function ensureSnapshotsDir() {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true })
}

/** Save the current page HTML to dom-snapshots/{pageKey}{suffix}.html */
async function saveDomSnapshot(page, pageKey, suffix = '') {
  ensureSnapshotsDir()
  const html = await page.content()
  const filename = suffix ? `${pageKey}--${suffix}.html` : `${pageKey}.html`
  const filepath = path.join(SNAPSHOTS_DIR, filename)
  fs.writeFileSync(filepath, html, 'utf8')
  log(`📸 Saved ${filename} (${Math.round(html.length / 1024)} KB)`)
  return filepath
}

/**
 * Collect all <select> elements with their options.
 * Returns [ { id, name, options: [{value, text}] } ]
 */
async function collectSelectOptions(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('select')).map((sel) => ({
      id:      sel.id,
      name:    sel.name,
      options: Array.from(sel.options).map((o) => ({ value: o.value, text: o.text.trim() })),
    }))
  })
}

/**
 * Expand all visible Yes/No radio buttons to "Yes" so conditional sub-fields
 * render into the DOM.  Returns the IDs of radios that were changed (so we can
 * restore them to "No" afterward).
 */
async function expandYesNoRadios(page) {
  // Find all "Yes" radios that are visible and currently NOT checked
  const changed = await page.evaluate(() => {
    const changed = []
    document.querySelectorAll('input[type="radio"][value="Y"], input[type="radio"][value="y"]').forEach((r) => {
      if (!r.checked && r.offsetParent !== null /* visible */) {
        r.click()
        r.checked = true
        r.dispatchEvent(new Event('change', { bubbles: true }))
        if (r.id) changed.push(r.id)
      }
    })
    return changed
  })
  return changed
}

/**
 * Reset Yes/No radios back to "No" for each ID that expandYesNoRadios changed.
 */
async function resetYesNoRadios(page, changedIds) {
  if (!changedIds.length) return
  await page.evaluate((ids) => {
    ids.forEach((id) => {
      const yesRadio = document.getElementById(id)
      if (!yesRadio) return
      // Find the sibling "No" radio in the same RadioButtonList (ASP.NET _0 → _1)
      const noId = id.replace(/_0$/, '_1')
      const noRadio = document.getElementById(noId)
        || document.querySelector(`input[type="radio"][name="${yesRadio.name}"][value="N"]`)
      if (noRadio) {
        noRadio.click()
        noRadio.checked = true
        noRadio.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
  }, changedIds)
}

/**
 * Detect the current DS-160 page context.
 *
 * PRIMARY: URL node= parameter — DS-160 puts the section name in ?node=XXX.
 * SECONDARY: URL path substrings (fallback for old / alternate URL formats).
 * TERTIARY: page heading text (h2/h3/legend).
 */
async function detectPageContext(page) {
  try {
    const url = page.url().toLowerCase()

    // ── node= parameter (most reliable — DS-160 always sets this) ───────────
    // e.g. ?node=Personal1, ?node=Travel, ?node=PreviousTravel
    const nodeMatch = url.match(/[?&]node=([^&]+)/)
    const node = nodeMatch ? nodeMatch[1] : ''

    if (node === 'personal1'  || node === 'personalinfo1')   return 'personal1'
    if (node === 'personal2'  || node === 'personalcont' ||
        node === 'personalinfo2')                             return 'personal2'
    if (node === 'travel'     || node === 'travelinfo')      return 'travel'
    if (node === 'travelcompanions' || node === 'companion') return 'companions'
    if (node === 'previoustravel'   || node === 'prevtravel') return 'prev_travel'
    if (node === 'addressphone'     || node === 'address')   return 'address'
    if (node === 'passport')                                  return 'passport'
    if (node === 'contactpeople'    || node === 'contact')   return 'contact'
    if (node === 'familyinfo'       || node === 'family')    return 'family'
    if (node === 'workeducationtraining' || node === 'work') return 'work_edu'
    if (node === 'securityandbackground' || node === 'security') return 'security'
    if (node === 'review'           || node === 'preview')   return 'review'
    if (node === 'securequestion'   || node.includes('secur')) return 'security_question'

    // ── URL path substrings ──────────────────────────────────────────────────
    if (url.includes('default.aspx'))                                  return 'captcha'
    if (url.includes('disclaimer'))                                    return 'disclaimer'
    if (url.includes('securequestion') || url.includes('securityquestion') ||
        url.includes('confirmapplicationid'))                          return 'security_question'
    // personalcont = Personal 2; must check before plain 'personal'
    if (url.includes('personalcont') || url.includes('personal_cont')) return 'personal2'
    if (url.includes('complete_personal') || url.includes('personalinfo1') ||
        url.includes('personal_info1'))                                return 'personal1'
    if (url.includes('personalinfo2') || url.includes('personal_info2')) return 'personal2'
    if (url.includes('travelcompanion') || url.includes('travel_companion')) return 'companions'
    if (url.includes('previoustravel') || url.includes('previous_travel'))   return 'prev_travel'
    if (url.includes('complete_travel') || url.includes('travelinfo') ||
        url.includes('travel_info'))                                   return 'travel'
    if (url.includes('addressphone') || url.includes('address_phone') ||
        url.includes('complete_address'))                              return 'address'
    if (url.includes('passport'))                                      return 'passport'
    if (url.includes('contactpeople') || url.includes('complete_contact')) return 'contact'
    if (url.includes('familyinfo') || url.includes('complete_family')) return 'family'
    if (url.includes('workeducation') || url.includes('work_education') ||
        url.includes('complete_work'))                                 return 'work_edu'
    if (url.includes('securityandbackground') || url.includes('security_background') ||
        url.includes('complete_security'))                             return 'security'
    if (url.includes('review') || url.includes('preview'))            return 'review'

    // ── Heading text fallback ────────────────────────────────────────────────
    for (const sel of ['h2', 'h3', 'legend', '.step-title']) {
      try {
        const text = (await page.locator(sel).first().textContent({ timeout: 500 }))?.toLowerCase() || ''
        if (text.includes('personal information 1'))   return 'personal1'
        if (text.includes('personal information 2'))   return 'personal2'
        if (text.includes('travel information'))       return 'travel'
        if (text.includes('travel companion'))         return 'companions'
        if (text.includes('previous u.s. travel') ||
            text.includes('previous us travel'))       return 'prev_travel'
        if (text.includes('address'))                  return 'address'
        if (text.includes('passport'))                 return 'passport'
        if (text.includes('contact'))                  return 'contact'
        if (text.includes('family'))                   return 'family'
        if (text.includes('work') || text.includes('education')) return 'work_edu'
        if (text.includes('security') && text.includes('background')) return 'security'
        if (text.includes('review') || text.includes('preview'))      return 'review'
        if (text.includes('security question') || text.includes('secure question')) return 'security_question'
      } catch { /* try next selector */ }
    }

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// ─── Core capture: snapshot a page in clean + expanded state ─────────────────

/**
 * Capture DOM snapshots and select-option manifest for the current page.
 *
 * Steps:
 *   1. Wait for DOM to stabilize
 *   2. Save clean HTML  →  {pageKey}.html
 *   3. Expand all Y/N radios to "Yes", wait for postbacks
 *   4. Save expanded HTML  →  {pageKey}--expanded.html
 *   5. Restore all changed radios back to "No"
 *   6. Return { pageKey, cleanFile, expandedFile, selects }
 */
async function capturePageSnapshots(page, pageKey) {
  const label = PAGE_NAMES[pageKey] || pageKey
  logSection(`📸 Capturing: ${label}`)

  // 1. Wait for DOM to fully stabilize
  await safeLoad(page, 'networkidle', 5000)
  await safeWait(page, 1000)

  // 2. Clean snapshot
  const cleanFile = await saveDomSnapshot(page, pageKey)

  // Collect select options while in clean state
  const selects = await collectSelectOptions(page)
  log(`   Found ${selects.length} <select> elements on this page`)

  // 3. Expand Y/N to "Yes"
  const changedIds = await expandYesNoRadios(page)
  log(`   Expanded ${changedIds.length} Yes/No radio(s) to "Yes"`)

  if (changedIds.length > 0) {
    // Wait for conditional fields / ASP.NET postbacks
    await safeLoad(page, 'domcontentloaded', 8000)
    await safeWait(page, 1500)

    // 4. Expanded snapshot
    await saveDomSnapshot(page, pageKey, 'expanded')

    // 5. Restore to No
    await resetYesNoRadios(page, changedIds)
    await safeLoad(page, 'domcontentloaded', 5000)
    await safeWait(page, 800)
    log(`   Restored ${changedIds.length} radio(s) to "No"`)
  } else {
    log(`   No Yes/No radios to expand — skipping expanded snapshot`)
    // Write same file as expanded so manifest is consistent
    await saveDomSnapshot(page, pageKey, 'expanded')
  }

  return { pageKey, label, url: page.url(), cleanFile, selects }
}

// ─── Modified agent loop with DOM capture ─────────────────────────────────────

const MAX_STEPS = 600
const MAX_CONSECUTIVE_ERRORS = 5

const PAGE_STALL_LIMITS = {
  travel: 60, security: 60, work_edu: 50, family: 50,
  address: 40, personal1: 35, personal2: 35, prev_travel: 35,
  passport: 35, contact: 30, companions: 25,
  security_question: 20, captcha: 15, disclaimer: 10, review: 20, unknown: 40,
}

async function runCrawler(page, translatedText, apiKey) {
  const manifest = []
  const capturedPages = new Set()
  const actionHistory = []
  let consecutiveErrors = 0
  let currentPageContext = 'unknown'
  let stepsOnCurrentPage = 0

  log('Crawler loop started.')

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`Step ${step}/${MAX_STEPS}`)

    await detectAndLogSection(page)

    // ── Page context detection ───────────────────────────────────────────────
    const pageContext = await detectPageContext(page)

    if (pageContext !== currentPageContext) {
      if (currentPageContext !== 'unknown') {
        log(`📄 Page changed: "${currentPageContext}" → "${pageContext}" (after ${stepsOnCurrentPage} steps)`)
      }
      currentPageContext = pageContext
      stepsOnCurrentPage = 1

      // ── DOM CAPTURE: new page encountered ───────────────────────────────
      if (pageContext !== 'unknown' && !capturedPages.has(pageContext)) {
        capturedPages.add(pageContext)
        try {
          const result = await capturePageSnapshots(page, pageContext)
          manifest.push(result)
          // Persist manifest after every page so partial runs are useful
          fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8')
          log(`📋 Manifest updated (${manifest.length} pages captured so far)`)
        } catch (captureErr) {
          logError(`Failed to capture snapshots for "${pageContext}"`, captureErr)
        }
      }
    } else {
      stepsOnCurrentPage++
    }

    // Stall guard
    const stallLimit = PAGE_STALL_LIMITS[pageContext] ?? 40
    if (stepsOnCurrentPage > stallLimit) {
      throw new Error(
        `⛔ Stall detected — stuck on "${pageContext}" for ${stepsOnCurrentPage} steps ` +
        `(limit: ${stallLimit}). Aborting.`
      )
    }

    log(`[page: ${pageContext}, step-on-page: ${stepsOnCurrentPage}]`)

    // Screenshot for GPT-4o
    const screenshot = await page.screenshot({ fullPage: false })

    let action
    try {
      action = await askAgent(screenshot, translatedText, actionHistory, apiKey)
      consecutiveErrors = 0
    } catch (err) {
      consecutiveErrors++
      logError(`Agent call failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`, err)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw new Error('Too many agent errors')
      await safeWait(page, 2000)
      continue
    }

    log(`▶ ${action.type}  ${JSON.stringify(action).slice(0, 120)}`)

    // Done / stop conditions
    if (action.type === 'done') {
      log('Agent returned "done" — all pages navigated.')
      break
    }

    // If the agent wants to go to the Review page we can stop (all form pages captured)
    if (pageContext === 'review') {
      log('Reached Review page — all form pages captured. Stopping crawler.')
      break
    }

    // CAPTCHA handler
    if (action.type === 'solveCaptcha') {
      let solved = ''
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          solved = await solveCaptchaOnPage(page, apiKey)
          const selectors = [
            'input[name*="captcha" i]', 'input[id*="captcha" i]',
            '#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha',
            '#ctl00_SiteContentPlaceHolder_ucAppSecurityQuestion_txtcaptcha',
          ]
          let filled = false
          for (const sel of selectors) {
            try {
              const el = page.locator(sel).first()
              await el.waitFor({ state: 'visible', timeout: 2000 })
              await el.fill(solved)
              filled = true
              break
            } catch { /* try next */ }
          }
          if (!filled) throw new Error('CAPTCHA input not found')
          // Click submit
          const btn = page.locator('input[type="submit"], button[type="submit"]').first()
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click()
            await safeLoad(page, 'domcontentloaded', 10000)
          }
          break
        } catch (err) {
          logWarn(`CAPTCHA attempt ${attempt} failed: ${err.message}`)
          await safeWait(page, 1000)
        }
      }
      actionHistory.push({ type: 'solveCaptcha', answer: solved })
      await safeWait(page, 500)
      continue
    }

    // Execute action
    try {
      await executeAction(page, action)
      actionHistory.push(action)
    } catch (err) {
      if (err.message.startsWith('⛔ BLOCKED')) {
        log(err.message)
        break
      }
      consecutiveErrors++
      logError(`Action failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${err.message}`, err)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw new Error('Too many action failures')
      actionHistory.push({ type: '_error', ...action, error: err.message })
    }

    await safeLoad(page, 'domcontentloaded', 8000).catch(() => {})
    await safeWait(page, 800)
  }

  // Final manifest write
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8')
  log(`\n✅ Crawler finished. ${capturedPages.size} pages captured.`)
  log(`📁 Snapshots saved to: ${SNAPSHOTS_DIR}`)
  log(`📋 Manifest: ${MANIFEST_FILE}`)
  log(`\nCaptured pages: ${[...capturedPages].join(', ')}`)
  return manifest
}

// ─── Setup (mirrors fill-ds160.js setupApplication) ──────────────────────────

async function setupApplication(page, apiKey) {
  logSection('Step 1 — Navigate to DS-160')
  await page.goto('https://ceac.state.gov/GenNIV/Default.aspx', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await safeWait(page, 2000)

  logSection('Step 2 — Select Embassy (Tel Aviv)')
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
      for (const s of allSelects) {
        const opts = await s.locator('option').all()
        const texts = await Promise.all(opts.slice(0, 3).map((o) => o.textContent()))
        const isLanguage = texts.some((t) => t && (t.includes('Arabic') || t.includes('Hebrew') || t.includes('Français')))
        if (!isLanguage) { ddl = s; break }
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

  logSection('Step 3 — Solve CAPTCHA')
  try {
    await page.waitForSelector('img[src*="aptcha" i], img[id*="aptcha" i]', {
      state: 'visible', timeout: 10000,
    })
  } catch {
    log('⚠️  CAPTCHA image not detected yet — solving anyway')
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const answer = await solveCaptchaOnPage(page, apiKey)
    const inputs = [
      '#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha',
      'input[name*="captcha" i]', 'input[id*="captcha" i]',
    ]
    for (const sel of inputs) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'visible', timeout: 3000 })
        await el.fill(answer)
        log(`CAPTCHA filled: "${answer}"`)
        break
      } catch { /* try next */ }
    }

    try {
      await page.getByRole('button', { name: /start an application/i }).click()
    } catch {
      try { await page.getByText('Start an Application', { exact: false }).click() } catch {}
    }

    await safeLoad(page, 'domcontentloaded', 15000)
    await safeWait(page, 1500)

    if (!page.url().includes('Default.aspx')) {
      log('✅ CAPTCHA accepted — navigated away from landing page')
      break
    }
    log(`⚠️  Still on Default.aspx — re-trying CAPTCHA (attempt ${attempt}/5)`)
  }

  logSection('Step 4 — I Agree')
  if (!page.url().includes('Default.aspx')) {
    const labels = ['I have read', 'I agree', 'agree']
    for (const lbl of labels) {
      try { await page.getByLabel(lbl, { exact: false }).check({ timeout: 3000 }); break } catch {}
    }
  }
  await safeLoad(page, 'domcontentloaded', 10000)
  await safeWait(page, 1000)

  logSection('Step 5 — Security Question')
  const sqSelectors = [
    'select[name*="SecurityQuestion"]', 'select[id*="SecurityQuestion"]',
    'select[id*="ddlQuestions"]', 'select',
  ]
  for (const sel of sqSelectors) {
    try {
      const el = page.locator(sel).first()
      await el.waitFor({ state: 'visible', timeout: 5000 })
      const options = await el.locator('option').all()
      for (const opt of options) {
        const txt = (await opt.textContent())?.toUpperCase() || ''
        if (txt.includes('HOME PHONE') || txt.includes('CHILD')) {
          const val = await opt.getAttribute('value')
          if (val) { await el.selectOption(val); log('✅ Security question set'); break }
        }
      }
      break
    } catch { /* try next */ }
  }
  const answerSelectors = [
    'input[name*="SecurityAnswer"]', 'input[id*="SecurityAnswer"]',
    'input[id*="txtAnswer"]', 'input[type="text"]',
  ]
  for (const sel of answerSelectors) {
    try {
      const el = page.locator(sel).first()
      await el.waitFor({ state: 'visible', timeout: 3000 })
      await el.fill('049824393')
      break
    } catch { /* try next */ }
  }
  try {
    await safeLoad(page, 'domcontentloaded', 5000)
    await safeWait(page, 1000)
    const nextBtn = page.getByRole('button', { name: /continue|next|ok/i })
    if (await nextBtn.isVisible({ timeout: 3000 })) {
      await nextBtn.click()
      await safeLoad(page, 'domcontentloaded', 10000)
      await safeWait(page, 1500)
    }
  } catch {}

  logSection('Step 6 — Apply For a Nonimmigrant Visa — Embassy Dropdown')
  try {
    await safeWait(page, 2000)
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
              try {
                const next = page.getByRole('button', { name: /next/i })
                if (await next.isVisible({ timeout: 2000 })) {
                  await next.click()
                  await safeLoad(page, 'domcontentloaded', 10000)
                  await safeWait(page, 1500)
                }
              } catch {}
              break
            }
          }
        }
      } catch {}
    }
  } catch (err) {
    log(`⚠️  Embassy dropdown: ${err.message}`)
  }

  log('Setup complete — handing over to crawler loop.')
}

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const inputIdx = args.indexOf('--input')
  if (inputIdx === -1 || !args[inputIdx + 1]) {
    console.error('Usage: node autofill/crawl-dom.js --input <path-to-translated.txt>')
    process.exit(1)
  }
  return { inputFile: args[inputIdx + 1] }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { inputFile } = parseArgs()

  const resolved = path.resolve(inputFile)
  if (!fs.existsSync(resolved)) {
    console.error(`Input file not found: ${resolved}`)
    process.exit(1)
  }
  const translatedText = fs.readFileSync(resolved, 'utf8').trim()
  log(`Loaded translated text from: ${resolved} (${translatedText.length} chars)`)

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set.')
    process.exit(1)
  }

  const headed = process.env.DS160_HEADED === '1'
  log(`Launching Chromium (${headed ? 'headed' : 'headless'})…`)
  log(`Snapshots will be saved to: ${SNAPSHOTS_DIR}`)

  ensureSnapshotsDir()

  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 50 : 0,
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) log(`↪ Navigated: ${frame.url()}`)
  })
  page.on('pageerror', (err) => logError('Page JS error', err))
  page.on('close', () => log('⚠️  PAGE CLOSED'))
  page.on('crash', () => log('💥 PAGE CRASHED'))

  try {
    await setupApplication(page, apiKey)
    await runCrawler(page, translatedText, apiKey)
  } catch (err) {
    logError('Fatal error', err)
    process.exitCode = 1
  } finally {
    if (!headed) await browser.close()
  }
}

main()
