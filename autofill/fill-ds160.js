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

  logSection('Application Setup — Embassy Selection')
  log('Navigating to DS-160…')
  await page.goto('https://ceac.state.gov/GenNIV/Default.aspx', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })

  // Select embassy location (Israel - Tel Aviv)
  log('Selecting U.S. Embassy — Israel, Tel Aviv…')
  const locationSelectors = [
    'select[name*="Location"]',
    'select[id*="Location"]',
    '#ctl00_SiteContentPlaceHolder_ucLocationSearch_ddlLocation',
    'select',
  ]
  let locationSelected = false
  for (const sel of locationSelectors) {
    try {
      const el = page.locator(sel).first()
      await el.waitFor({ state: 'visible', timeout: 5000 })
      // Try exact match first, then partial
      try {
        await el.selectOption({ label: 'Israel - Tel Aviv' })
        locationSelected = true
        break
      } catch {
        // Try to find any option containing "Tel Aviv"
        const options = await el.locator('option').all()
        for (const opt of options) {
          const txt = await opt.textContent()
          if (txt && txt.includes('Tel Aviv')) {
            const val = await opt.getAttribute('value')
            if (val) {
              await el.selectOption(val)
              locationSelected = true
              break
            }
          }
        }
        if (locationSelected) break
      }
    } catch { /* try next */ }
  }
  if (!locationSelected) {
    log('⚠️  Could not auto-select embassy location — agent will handle it')
  } else {
    log('Embassy location selected.')
    // Wait for page to reload after location selection
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 })
    } catch { /* continue */ }
  }

  logSection('CAPTCHA — Initial')
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
      break
    } catch { /* try next */ }
  }
  if (!captchaFilled) log('⚠️  Could not fill initial CAPTCHA — agent will handle it')

  // Click "Start an Application"
  logSection('Start Application')
  log('Clicking "Start an Application"…')
  try {
    await page.getByRole('button', { name: /start an application/i }).click()
  } catch {
    try {
      await page.getByText('Start an Application', { exact: false }).click()
    } catch {
      log('⚠️  Could not find "Start an Application" button — agent will handle it')
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})

  // Check "I agree" checkbox
  log('Checking "I agree"…')
  try {
    const agreeCheckbox = page
      .locator('input[type="checkbox"]')
      .filter({ hasText: '' })
      .first()
    // Try by label text
    const labels = ['I have read', 'I agree', 'agree']
    let checked = false
    for (const lbl of labels) {
      try {
        await page.getByLabel(lbl, { exact: false }).check()
        checked = true
        break
      } catch { /* try next */ }
    }
    if (!checked) {
      // Fallback: check any unchecked checkbox visible on the page
      const cbs = await page.locator('input[type="checkbox"]').all()
      for (const cb of cbs) {
        if (await cb.isVisible()) {
          await cb.check()
          break
        }
      }
    }
  } catch {
    log('⚠️  Could not find "I agree" checkbox — agent will handle it')
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

  // Security question
  logSection('Security Question Setup')
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
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    const nextBtn = page.getByRole('button', { name: /continue|next|ok/i })
    if (await nextBtn.isVisible({ timeout: 3000 })) {
      await nextBtn.click()
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    }
  } catch { /* agent handles remaining navigation */ }

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
    slowMo: headed ? 80 : 0,
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
