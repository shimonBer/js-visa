#!/usr/bin/env node
/**
 * DS-160 Auto-fill Entry Point
 *
 * Usage:
 *   npm run autofill -- --input /path/to/translated.txt
 *   node autofill/fill-ds160.js --input /path/to/translated.txt
 *
 * The translated.txt file is downloaded from the app UI after a successful
 * translation (click "Download for Auto-fill" in the translation result panel).
 *
 * ⛔ DEVELOPMENT MODE — this script NEVER submits the DS-160 form.
 *    It stops at the preview/review phase.
 *
 * Logs every section change and every action to stdout.
 * Set DS160_HEADED=1 to run with a visible browser window.
 */

import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'
import { runAgent, log, logSection, logError } from './agent.js'

/** waitForTimeout that never throws even if the page navigates away */
async function safeWait(page, ms) {
  try { await page.waitForTimeout(ms) } catch { /* page navigated or closed */ }
}

/** waitForLoadState that never throws */
async function safeLoad(page, state = 'domcontentloaded', timeout = 12000) {
  try { await page.waitForLoadState(state, { timeout }) } catch { /* continue */ }
}

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const inputIdx = args.indexOf('--input')
  if (inputIdx === -1 || !args[inputIdx + 1]) {
    console.error('Usage: node autofill/fill-ds160.js --input <path-to-translated.txt>')
    console.error('  Download the translated.txt from the app UI after a successful translation.')
    process.exit(1)
  }
  return { inputFile: args[inputIdx + 1] }
}

// ─── Read translated text ────────────────────────────────────────────────────

function readTranslatedText(filePath) {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    console.error(`Input file not found: ${resolved}`)
    process.exit(1)
  }
  const text = fs.readFileSync(resolved, 'utf8').trim()
  if (!text) {
    console.error(`Input file is empty: ${resolved}`)
    process.exit(1)
  }
  log(`Loaded translated text from: ${resolved} (${text.length} chars)`)
  return text
}

// ─── DS-160 initial setup ────────────────────────────────────────────────────

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
async function setupApplication(page, apiKey) {
  const { solveCaptchaOnPage } = await import('./agent.js')

  // ── Step 1: Navigate ────────────────────────────────────────────────────────
  logSection('Step 1 — Navigate to DS-160')
  log('Navigating to DS-160…')
  await page.goto('https://ceac.state.gov/GenNIV/Default.aspx', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await safeWait(page, 2000)

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

  const captchaAnswer = await solveCaptchaOnPage(page, apiKey)

  // Fill the CAPTCHA input
  const captchaInputs = [
    '#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha',
    'input[name*="captcha" i]',
    'input[id*="captcha" i]',
  ]
  let captchaFilled = false
  for (const sel of captchaInputs) {
    try {
      const el = page.locator(sel).first()
      await el.waitFor({ state: 'visible', timeout: 3000 })
      await el.fill(captchaAnswer)
      captchaFilled = true
      log(`CAPTCHA filled: "${captchaAnswer}"`)
      break
    } catch { /* try next */ }
  }
  if (!captchaFilled) log('⚠️  Could not fill CAPTCHA input — agent will handle it')

  // ── Step 4: Click "Start an Application" (retry if CAPTCHA was wrong) ────────
  logSection('Step 4 — Start an Application')
  for (let captchaAttempt = 1; captchaAttempt <= 5; captchaAttempt++) {
    log(`Clicking "Start an Application"… (attempt ${captchaAttempt})`)
    try {
      await page.getByRole('button', { name: /start an application/i }).click()
    } catch {
      try {
        await page.getByText('Start an Application', { exact: false }).click()
      } catch {
        log('⚠️  Could not find "Start an Application" button')
      }
    }

    await safeLoad(page, 'domcontentloaded', 15000)
    await safeWait(page, 1500)

    // Check if we navigated away from the landing page
    const urlAfter = page.url()
    log(`URL after click: ${urlAfter}`)
    if (!urlAfter.includes('Default.aspx')) {
      log('✅ Navigation successful — CAPTCHA was accepted')
      break
    }

    // Still on Default.aspx — CAPTCHA was rejected. Re-solve and try again.
    log(`⚠️  Still on Default.aspx — CAPTCHA was wrong, re-solving… (attempt ${captchaAttempt}/5)`)
    if (captchaAttempt < 5) {
      const newAnswer = await solveCaptchaOnPage(page, apiKey)
      if (newAnswer) {
        const captchaInputs = [
          '#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha',
          'input[name*="captcha" i]',
          'input[id*="captcha" i]',
        ]
        for (const sel of captchaInputs) {
          try {
            const el = page.locator(sel).first()
            await el.waitFor({ state: 'visible', timeout: 3000 })
            await el.fill(newAnswer)
            log(`CAPTCHA re-filled: "${newAnswer}"`)
            break
          } catch { /* try next */ }
        }
      }
      await safeWait(page, 500)
    }
  }

  // ── Step 5: I Agree ──────────────────────────────────────────────────────────
  logSection('Step 5 — I Agree')
  log(`Current URL: ${page.url()}`)
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
  log('Setting security question…')
  const targetQuestion = 'WHAT WAS YOUR HOME PHONE NUMBER WHEN YOU WERE A CHILD?'
  const securityAnswer = '049824393'

  try {
    // Find the security question dropdown
    const sqSelectors = [
      'select[name*="SecurityQuestion"]',
      'select[id*="SecurityQuestion"]',
      'select[id*="ddlQuestions"]',
      'select',
    ]
    let questionSet = false
    for (const sel of sqSelectors) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'visible', timeout: 5000 })
        const options = await el.locator('option').all()
        for (const opt of options) {
          const txt = (await opt.textContent())?.toUpperCase() || ''
          if (txt.includes('HOME PHONE') || txt.includes('CHILD')) {
            const val = await opt.getAttribute('value')
            if (val) {
              await el.selectOption(val)
              questionSet = true
              break
            }
          }
        }
        if (questionSet) break
      } catch { /* try next */ }
    }
    if (!questionSet) {
      log('⚠️  Could not auto-select security question — agent will handle it')
    } else {
      log(`Security question set: "${targetQuestion}"`)
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
    log(`⚠️  Security question setup error: ${err.message} — agent will handle it`)
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

  log('Initial setup complete — handing over to agent loop.')
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { inputFile } = parseArgs()
  const translatedText = readTranslatedText(inputFile)

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set. Add it to your .env file.')
    process.exit(1)
  }

  const headed = process.env.DS160_HEADED === '1'
  log(`Launching Chromium (${headed ? 'headed' : 'headless'})…`)

  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 50 : 0,
  })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })

  const page = await context.newPage()

  // Log every navigation
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      log(`↪ Navigated to: ${frame.url()}`)
    }
  })

  // Log console errors from the page
  page.on('pageerror', (err) => {
    logError('Page JS error', err)
  })

  // Log when page or browser closes unexpectedly
  page.on('close', () => log('⚠️  PAGE CLOSED (browser window was closed or tab crashed)'))
  page.on('crash', () => log('💥 PAGE CRASHED'))
  context.on('close', () => log('⚠️  BROWSER CONTEXT CLOSED'))

  try {
    await setupApplication(page, apiKey)
    await runAgent(page, translatedText, apiKey)

    log('')
    log('════════════════════════════════════════════════════')
    log('⛔  DEVELOPMENT MODE — FORM WAS NOT SUBMITTED')
    log('════════════════════════════════════════════════════')
    log('Review the form in the terminal log above.')
    if (headed) {
      log('Browser window is open — inspect the form, then close this terminal.')
    }
  } catch (err) {
    logError('Fatal error', err)
    process.exitCode = 1
  } finally {
    if (!headed) {
      await browser.close()
    }
    // In headed mode, keep the browser open for inspection
  }
}

main()
