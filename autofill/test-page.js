#!/usr/bin/env node
/**
 * DS-160 Page Tester — run translated.txt against a local DOM snapshot
 *
 * Loads a saved DOM snapshot as a local file in Playwright (no real DS-160 site,
 * no CAPTCHA, no network except the configured OpenAI API calls).
 * The agent fills fields exactly as it would on the live site.
 * Stops automatically before any "Next / Continue" navigation click so the
 * snapshot page is never unloaded.
 *
 * Usage:
 *   node autofill/test-page.js --snapshot dom-snapshots/personal1--expanded.html \
 *                               --input translated.txt
 *
 *   # With a visible browser window:
 *   DS160_HEADED=1 node autofill/test-page.js --snapshot personal1--expanded.html \
 *                                              --input translated.txt
 *
 * Exit:
 *   0  — all visible fields on the page were filled successfully
 *   1  — one or more fields could not be filled
 */

import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'
import {
  executeAction,
  askAgent,
  log,
  logSection,
  logError,
  logWarn,
} from './agent.js'

// ─── Section patterns (mirror of agent.js filterTranslatedText) ───────────────

const SECTION_PATTERNS = {
  personal1:   /PERSONAL INFORMATION 1[\s\S]*?(?=\nPERSONAL INFORMATION 2|\n🟦|$)/i,
  personal2:   /PERSONAL INFORMATION 2[\s\S]*?(?=\n🟦|$)/i,
  travel:      /🟦 TRAVEL INFORMATION[\s\S]*?(?=\n🟦|$)/i,
  companions:  /🟦 TRAVEL COMPANIONS[\s\S]*?(?=\n🟦|$)/i,
  prev_travel: /🟦 PREVIOUS U\.?S\.? TRAVEL[\s\S]*?(?=\n🟦|$)/i,
  address:     /🟦 ADDRESS AND PHONE[\s\S]*?(?=\n🟦|$)/i,
  passport:    /🟦 PASSPORT[\s\S]*?(?=\n🟦|$)/i,
  contact:     /🟦 CONTACT[\s\S]*?(?=\n🟦|$)/i,
  family:      /🟦 FAMILY[\s\S]*?(?=\n🟦|$)/i,
  work_edu:    /🟦 WORK.*EDUCATION[\s\S]*?(?=\n🟦|$)/i,
  security:    /🟦 SECURITY[\s\S]*?(?=\n🟦|$)/i,
}

/** Infer page context key from snapshot filename, e.g. "personal1--expanded.html" → "personal1" */
function inferPageContext(snapshotPath) {
  const base = path.basename(snapshotPath, '.html').replace(/--.*$/, '')
  return base  // e.g. "personal1", "travel", "passport"
}

function filterText(translatedText, pageContext) {
  const pattern = SECTION_PATTERNS[pageContext]
  if (!pattern) return translatedText
  const match = translatedText.match(pattern)
  return match ? match[0].trim() : translatedText
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag) => {
    const idx = args.indexOf(flag)
    return idx !== -1 ? args[idx + 1] : null
  }
  const snapshotArg = get('--snapshot')
  const inputArg    = get('--input')
  if (!snapshotArg || !inputArg) {
    console.error(
      'Usage: node autofill/test-page.js --snapshot <path-to.html> --input <translated.txt>'
    )
    process.exit(1)
  }
  const snapshotFile = path.resolve(snapshotArg)
  const inputFile    = path.resolve(inputArg)
  if (!fs.existsSync(snapshotFile)) {
    console.error(`Snapshot not found: ${snapshotFile}`)
    process.exit(1)
  }
  if (!fs.existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`)
    process.exit(1)
  }
  return { snapshotFile, inputFile }
}

// ─── Navigation-action detector ───────────────────────────────────────────────

const NAV_PATTERNS = [
  /^next/i, /^continue/i, /^sign and submit/i, /^submit/i,
]

function isNavigationAction(action) {
  if (action.type !== 'click') return false
  const target = (action.text || action.label || '').trim()
  return NAV_PATTERNS.some((p) => p.test(target))
}

// ─── Results reporter ─────────────────────────────────────────────────────────

function printSummary(results) {
  const bar = '═'.repeat(60)
  console.log(`\n${bar}`)
  console.log('TEST RESULTS')
  console.log(bar)

  const ok  = results.filter((r) => r.status === 'ok')
  const err = results.filter((r) => r.status === 'error')
  const nav = results.filter((r) => r.status === 'nav-stop')

  console.log(`✅ Filled:     ${ok.length}`)
  console.log(`❌ Failed:     ${err.length}`)
  console.log(`🛑 Nav-stop:   ${nav.length}`)
  console.log(bar)

  if (err.length) {
    console.log('\nFailed actions:')
    err.forEach((r) => {
      console.log(`  ❌ ${r.action.type} label="${r.action.label || ''}" text="${r.action.text || ''}"`)
      console.log(`     → ${r.error}`)
    })
  }

  if (ok.length) {
    console.log('\nSuccessfully filled actions:')
    ok.forEach((r) => {
      const a = r.action
      const desc = [a.type, a.label && `label="${a.label}"`, a.value && `value="${a.value}"`]
        .filter(Boolean).join('  ')
      console.log(`  ✅ ${desc}`)
    })
  }

  console.log(bar)
}

// ─── Main test loop ───────────────────────────────────────────────────────────

const MAX_STEPS = 80
const MAX_CONSECUTIVE_ERRORS = 4

async function runTest(page, translatedText, pageContext, apiKey) {
  const actionHistory = []
  const results = []
  let consecutiveErrors = 0

  logSection(`Testing page: ${pageContext}`)
  log(`Relevant translated text (${filterText(translatedText, pageContext).length} chars)`)

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`Step ${step}/${MAX_STEPS}`)

    const screenshot = await page.screenshot({ fullPage: true }).catch(async () => {
      // Fallback: viewport-only screenshot
      return page.screenshot({ fullPage: false })
    })

    let action
    try {
      action = await askAgent(screenshot, filterText(translatedText, pageContext), actionHistory, apiKey)
      consecutiveErrors = 0
    } catch (err) {
      consecutiveErrors++
      logError(`Agent call failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`, err)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log('Too many consecutive agent errors — stopping.')
        break
      }
      await page.waitForTimeout(1500)
      continue
    }

    log(`▶ ${action.type}  ${JSON.stringify(action).slice(0, 120)}`)

    // ── Stop conditions ──────────────────────────────────────────────────────

    if (action.type === 'done') {
      log('Agent returned "done" — all fields on this page are filled.')
      results.push({ status: 'nav-stop', action })
      break
    }

    if (isNavigationAction(action)) {
      log(`🛑 Navigation action detected ("${action.text || action.label}") — stopping here.`)
      log('    All fillable fields have been processed.')
      results.push({ status: 'nav-stop', action })
      break
    }

    // solveCaptcha should never appear on a local snapshot, but guard anyway
    if (action.type === 'solveCaptcha') {
      log('⚠️  solveCaptcha on a local snapshot — skipping.')
      actionHistory.push({ type: 'solveCaptcha', answer: 'N/A' })
      continue
    }

    // ── Execute ──────────────────────────────────────────────────────────────

    try {
      await executeAction(page, action)
      actionHistory.push(action)
      results.push({ status: 'ok', action })
    } catch (err) {
      consecutiveErrors++
      logError(`Action failed: ${err.message}`)
      results.push({ status: 'error', action, error: err.message })
      actionHistory.push({ type: '_error', ...action, error: err.message })
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log('Too many consecutive failures — stopping.')
        break
      }
    }

    // Local HTML has no network — just a brief pause for DOM updates
    await page.waitForTimeout(300)
  }

  return results
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const { snapshotFile, inputFile } = parseArgs()

  const translatedText = fs.readFileSync(inputFile, 'utf8').trim()
  log(`Loaded translated text: ${translatedText.length} chars`)

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set.')
    process.exit(1)
  }

  const pageContext = inferPageContext(snapshotFile)
  log(`Snapshot:     ${snapshotFile}`)
  log(`Page context: ${pageContext}`)

  const headed = process.env.DS160_HEADED === '1'
  log(`Browser mode: ${headed ? 'headed' : 'headless'}`)

  const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 60 : 0 })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page    = await context.newPage()

  // Load snapshot as a local file — no network, no CAPTCHA
  await page.goto(`file://${snapshotFile}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  // Suppress ASP.NET postbacks: form.submit() would navigate away from the
  // local file (to the real ceac.state.gov), causing Playwright to wait for
  // an external page load (up to 2 min).  Making __doPostBack a no-op keeps
  // all conditional-field JS working while blocking navigation.
  await page.evaluate(() => {
    if (typeof window.__doPostBack === 'function') {
      window.__doPostBack = function() {}
    }
    document.querySelectorAll('form').forEach(f => {
      f.submit = function() {}
    })
  }).catch(() => {})

  log(`Loaded snapshot in browser. Page title: "${await page.title()}"`)

  let results = []
  let exitCode = 0

  try {
    results = await runTest(page, translatedText, pageContext, apiKey)
    const failures = results.filter((r) => r.status === 'error')
    if (failures.length > 0) exitCode = 1
  } catch (err) {
    logError('Fatal error', err)
    exitCode = 1
  } finally {
    printSummary(results)

    // Save a final screenshot of the filled page
    try {
      const screenshotDir = path.join(process.cwd(), 'dom-snapshots')
      const screenshotFile = path.join(screenshotDir, `${pageContext}--filled.png`)
      await page.screenshot({ path: screenshotFile, fullPage: true })
      log(`\n📷 Final screenshot saved: ${screenshotFile}`)
    } catch { /* ignore */ }

    if (headed) {
      log('\nBrowser window is open — inspect the filled form, then Ctrl+C to exit.')
    } else {
      await browser.close()
    }
  }

  process.exit(exitCode)
}

main()
