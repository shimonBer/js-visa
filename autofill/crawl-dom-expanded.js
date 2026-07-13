#!/usr/bin/env node
/**
 * DS-160 DOM Snapshot Crawler — "Expanded" variant
 *
 * Same navigation flow as crawl-dom.js, but with a more thorough expansion
 * strategy for each page:
 *
 *   Instead of batch-clicking all Yes radios in one JS evaluate() call, this
 *   script clicks each visible Yes/No radio button ONE AT A TIME via Playwright,
 *   waits for the ASP.NET postback / UpdatePanel to fully settle between each
 *   click, then checks for newly-revealed radios and repeats until no more
 *   unchecked Yes radios remain.
 *
 *   This ensures conditional sub-questions that appear only after a prior "Yes"
 *   answer are themselves expanded before the final DOM snapshot is taken.
 *
 * Output: dom-snapshots/{pageKey}--expanded.html  (fully expanded DOM)
 *         dom-snapshots/manifest.json
 *
 * Usage:
 *   node autofill/crawl-dom-expanded.js --input /path/to/translated.txt
 *   DS160_HEADED=1 node autofill/crawl-dom-expanded.js --input /path/to/translated.txt
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

async function saveDomSnapshot(page, pageKey, suffix = '') {
  ensureSnapshotsDir()
  const html = await page.content()
  const filename = suffix ? `${pageKey}--${suffix}.html` : `${pageKey}.html`
  const filepath = path.join(SNAPSHOTS_DIR, filename)
  fs.writeFileSync(filepath, html, 'utf8')
  log(`📸 Saved ${filename} (${Math.round(html.length / 1024)} KB)`)
  return filepath
}

async function collectSelectOptions(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('select')).map((sel) => ({
      id:      sel.id,
      name:    sel.name,
      options: Array.from(sel.options).map((o) => ({ value: o.value, text: o.text.trim() })),
    }))
  })
}

// ─── Sequential Yes-radio expander ───────────────────────────────────────────

/**
 * Click every visible unchecked "Yes" radio on the page one at a time.
 *
 * After each click we wait for the page to settle (network idle, then a brief
 * pause) so that ASP.NET postbacks and UpdatePanel refreshes complete before we
 * look for the next radio.  We repeat until a full pass finds nothing new to
 * click (handles cascading sub-questions revealed by prior Yes answers).
 *
 * Returns the total number of radios clicked.
 */
async function expandAllYesRadiosSequentially(page) {
  const MAX_PASSES = 10 // safety limit against infinite loops
  let totalClicked = 0

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    // Collect all visible, currently-unchecked Yes radios
    const yesRadios = await page.locator(
      'input[type="radio"][value="Y"]:not(:checked), ' +
      'input[type="radio"][value="y"]:not(:checked)'
    ).all()

    let clickedThisPass = 0

    for (const radio of yesRadios) {
      try {
        // Skip radios that are hidden or disabled
        if (!await radio.isVisible({ timeout: 500 }).catch(() => false)) continue
        if (!await radio.isEnabled({ timeout: 500 }).catch(() => false)) continue

        await radio.scrollIntoViewIfNeeded().catch(() => {})
        await radio.click()
        clickedThisPass++
        totalClicked++

        log(`   ✅ Clicked Yes radio (pass ${pass}, click ${clickedThisPass})`)

        // Wait for ASP.NET postback / UpdatePanel to finish before continuing.
        // networkidle is the most reliable signal that the partial-page update
        // (if any) has completed and new conditional fields are in the DOM.
        await safeLoad(page, 'networkidle', 8000)
        await safeWait(page, 600)
      } catch (err) {
        // Radio may have been removed from DOM by a prior postback — skip it
        log(`   ⚠️  Could not click radio: ${err.message?.slice(0, 80)}`)
      }
    }

    if (clickedThisPass === 0) {
      log(`   Pass ${pass}: no new Yes radios found — expansion complete.`)
      break
    }

    log(`   Pass ${pass}: clicked ${clickedThisPass} Yes radio(s). Checking for new ones…`)
  }

  return totalClicked
}

/**
 * Reset all visible Yes-selected radios back to No.
 * Used to clean up after snapshot so the agent can navigate normally.
 */
async function resetYesRadiosToNo(page) {
  const reset = await page.evaluate(() => {
    let count = 0
    document.querySelectorAll('input[type="radio"][value="Y"]:checked, input[type="radio"][value="y"]:checked')
      .forEach((yesRadio) => {
        if (yesRadio.offsetParent === null) return // hidden
        // Find the companion No radio (ASP.NET _0 → _1, or value="N")
        const noId = yesRadio.id.replace(/_0$/, '_1')
        const noRadio = document.getElementById(noId)
          || document.querySelector(
              `input[type="radio"][name="${yesRadio.name}"][value="N"], ` +
              `input[type="radio"][name="${yesRadio.name}"][value="n"]`
             )
        if (noRadio) {
          noRadio.click()
          noRadio.checked = true
          noRadio.dispatchEvent(new Event('change', { bubbles: true }))
          count++
        }
      })
    return count
  })
  return reset
}

// ─── Page context detector ────────────────────────────────────────────────────

async function detectPageContext(page) {
  try {
    const url = page.url().toLowerCase()

    const nodeMatch = url.match(/[?&]node=([^&]+)/)
    const node = nodeMatch ? nodeMatch[1] : ''

    if (node === 'personal1'  || node === 'personalinfo1')    return 'personal1'
    if (node === 'personal2'  || node === 'personalcont' ||
        node === 'personalinfo2')                              return 'personal2'
    if (node === 'travel'     || node === 'travelinfo')       return 'travel'
    if (node === 'travelcompanions' || node === 'companion')  return 'companions'
    if (node === 'previoustravel'   || node === 'prevtravel') return 'prev_travel'
    if (node === 'addressphone'     || node === 'address')    return 'address'
    if (node === 'passport')                                   return 'passport'
    if (node === 'contactpeople'    || node === 'contact')    return 'contact'
    if (node === 'familyinfo'       || node === 'family')     return 'family'
    if (node === 'workeducationtraining' || node === 'work')  return 'work_edu'
    if (node === 'securityandbackground' || node === 'security') return 'security'
    if (node === 'review'           || node === 'preview')    return 'review'
    if (node === 'securequestion'   || node.includes('secur'))return 'security_question'

    if (url.includes('default.aspx'))                                   return 'captcha'
    if (url.includes('disclaimer'))                                     return 'disclaimer'
    if (url.includes('securequestion') || url.includes('securityquestion') ||
        url.includes('confirmapplicationid'))                           return 'security_question'
    if (url.includes('personalcont') || url.includes('personal_cont')) return 'personal2'
    if (url.includes('complete_personal') || url.includes('personalinfo1') ||
        url.includes('personal_info1'))                                 return 'personal1'
    if (url.includes('personalinfo2') || url.includes('personal_info2'))return 'personal2'
    if (url.includes('travelcompanion') || url.includes('travel_companion')) return 'companions'
    if (url.includes('previoustravel') || url.includes('previous_travel'))   return 'prev_travel'
    if (url.includes('complete_travel') || url.includes('travelinfo') ||
        url.includes('travel_info'))                                    return 'travel'
    if (url.includes('addressphone') || url.includes('address_phone') ||
        url.includes('complete_address'))                               return 'address'
    if (url.includes('passport'))                                       return 'passport'
    if (url.includes('contactpeople') || url.includes('complete_contact')) return 'contact'
    if (url.includes('familyinfo') || url.includes('complete_family'))  return 'family'
    if (url.includes('workeducation') || url.includes('work_education') ||
        url.includes('complete_work'))                                  return 'work_edu'
    if (url.includes('securityandbackground') || url.includes('security_background') ||
        url.includes('complete_security'))                              return 'security'
    if (url.includes('review') || url.includes('preview'))             return 'review'

    for (const sel of ['h2', 'h3', 'legend', '.step-title']) {
      try {
        const text = (await page.locator(sel).first().textContent({ timeout: 500 }))?.toLowerCase() || ''
        if (text.includes('personal information 1'))    return 'personal1'
        if (text.includes('personal information 2'))    return 'personal2'
        if (text.includes('travel information'))        return 'travel'
        if (text.includes('travel companion'))          return 'companions'
        if (text.includes('previous u.s. travel') ||
            text.includes('previous us travel'))        return 'prev_travel'
        if (text.includes('address'))                   return 'address'
        if (text.includes('passport'))                  return 'passport'
        if (text.includes('contact'))                   return 'contact'
        if (text.includes('family'))                    return 'family'
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

// ─── Core capture ─────────────────────────────────────────────────────────────

/**
 * Capture the fully-expanded DOM for the current page.
 *
 * Steps:
 *   1. Wait for the DOM to stabilise
 *   2. Collect select options (clean state)
 *   3. Click every visible Yes radio one by one, waiting for postbacks between clicks
 *   4. Repeat until no new unchecked Yes radios remain (cascading sub-questions)
 *   5. Save the expanded HTML → {pageKey}--expanded.html
 *   6. Reset radios back to No so the agent can navigate forward cleanly
 */
async function captureExpandedSnapshot(page, pageKey) {
  const label = PAGE_NAMES[pageKey] || pageKey
  logSection(`📸 Capturing expanded DOM: ${label}`)

  // 1. Stabilise
  await safeLoad(page, 'networkidle', 6000)
  await safeWait(page, 1000)

  // 2. Collect select options
  const selects = await collectSelectOptions(page)
  log(`   Found ${selects.length} <select> elements`)

  // 3. & 4. Sequentially click all Yes radios with postback waits
  const totalClicked = await expandAllYesRadiosSequentially(page)
  log(`   Total Yes radios clicked across all passes: ${totalClicked}`)

  // Give the page one final settle after all expansions
  await safeLoad(page, 'networkidle', 6000)
  await safeWait(page, 800)

  // 5. Save expanded DOM
  const expandedFile = await saveDomSnapshot(page, pageKey, 'expanded')

  // 6. Reset back to No so agent navigation is unaffected
  if (totalClicked > 0) {
    const resetCount = await resetYesRadiosToNo(page)
    await safeLoad(page, 'networkidle', 5000)
    await safeWait(page, 800)
    log(`   Reset ${resetCount} radio(s) back to No`)
  }

  return { pageKey, label, url: page.url(), expandedFile, selects }
}

// ─── Crawler loop ─────────────────────────────────────────────────────────────

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

  log('Expanded-DOM crawler loop started.')

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`Step ${step}/${MAX_STEPS}`)

    await detectAndLogSection(page)

    const pageContext = await detectPageContext(page)

    if (pageContext !== currentPageContext) {
      if (currentPageContext !== 'unknown') {
        log(`📄 Page changed: "${currentPageContext}" → "${pageContext}" (after ${stepsOnCurrentPage} steps)`)
      }
      currentPageContext = pageContext
      stepsOnCurrentPage = 1

      // Capture expanded DOM on first visit to each new page
      if (pageContext !== 'unknown' && !capturedPages.has(pageContext)) {
        capturedPages.add(pageContext)
        try {
          const result = await captureExpandedSnapshot(page, pageContext)
          manifest.push(result)
          fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8')
          log(`📋 Manifest updated (${manifest.length} pages captured so far)`)
        } catch (captureErr) {
          logError(`Failed to capture expanded snapshot for "${pageContext}"`, captureErr)
        }
      }
    } else {
      stepsOnCurrentPage++
    }

    const stallLimit = PAGE_STALL_LIMITS[pageContext] ?? 40
    if (stepsOnCurrentPage > stallLimit) {
      throw new Error(
        `⛔ Stall detected — stuck on "${pageContext}" for ${stepsOnCurrentPage} steps ` +
        `(limit: ${stallLimit}). Aborting.`
      )
    }

    log(`[page: ${pageContext}, step-on-page: ${stepsOnCurrentPage}]`)

    if (pageContext === 'review') {
      log('Reached Review page — all form pages captured. Stopping crawler.')
      break
    }

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

    if (action.type === 'done') {
      log('Agent returned "done" — all pages navigated.')
      break
    }

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

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8')
  log(`\n✅ Crawler finished. ${capturedPages.size} pages captured.`)
  log(`📁 Expanded snapshots saved to: ${SNAPSHOTS_DIR}`)
  log(`📋 Manifest: ${MANIFEST_FILE}`)
  log(`\nCaptured pages: ${[...capturedPages].join(', ')}`)
  return manifest
}

// ─── Application setup (mirrors crawl-dom.js exactly) ────────────────────────

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

  log('Setup complete — handing over to expanded crawler loop.')
}

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const inputIdx = args.indexOf('--input')
  if (inputIdx === -1 || !args[inputIdx + 1]) {
    console.error('Usage: node autofill/crawl-dom-expanded.js --input <path-to-translated.txt>')
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
  log(`Expanded snapshots will be saved to: ${SNAPSHOTS_DIR}`)

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
