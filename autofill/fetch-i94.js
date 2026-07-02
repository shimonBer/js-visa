#!/usr/bin/env node
/**
 * I-94 Travel History Fetcher
 *
 * Uses local Playwright + GPT-4o vision — the same mechanism as the DS-160
 * autofill — to navigate i94.cbp.dhs.gov and extract past US visit records.
 * Running locally avoids the bot-detection issues that plagued Browser Use.
 *
 * Usage:
 *   node autofill/fetch-i94.js \
 *     --firstName "JOHN" --lastName "DOE" \
 *     --birthDate "01/15/1985" \
 *     --passport "AB1234567" \
 *     --country "Israel"
 *
 * Options:
 *   --headed      Show browser window (default: yes — less bot detection)
 *   --headless    Run headlessly
 *   --output      Path to write JSON result (default: i94-result.json)
 *
 * reCAPTCHA is solved automatically using GPT-4o vision.
 */

import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'

// ─── Config ──────────────────────────────────────────────────────────────────

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_TIMEOUT_MS = 60_000
const MAX_STEPS = 60

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().slice(11, 23)
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`)
}

function logError(msg, err) {
  console.error(`[${ts()}] ❌ ${msg}`, err?.message ?? err ?? '')
}

function logWarn(msg) {
  console.warn(`[${ts()}] ⚠️  ${msg}`)
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ─── reCAPTCHA solver ────────────────────────────────────────────────────────

/**
 * Ask GPT-4o to look at a reCAPTCHA image challenge screenshot and return
 * which grid cells (1-based, row-major) contain the target object.
 * Returns an array of 1-based indices, e.g. [1, 3, 7].
 */
async function askGpt4oRecaptcha(screenshotB64, apiKey) {
  const resp = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotB64}`, detail: 'high' } },
          {
            type: 'text',
            text: [
              'This is a reCAPTCHA image challenge.',
              'Identify which grid cells contain the target object described in the instruction at the top.',
              'Number the cells left-to-right, top-to-bottom starting at 1.',
              'Reply with ONLY a JSON array of cell numbers, e.g. [1,4,7].',
              'If none match, reply []. No explanation.',
            ].join('\n'),
          },
        ],
      }],
    }),
  })
  if (!resp.ok) throw new Error(`OpenAI reCAPTCHA ${resp.status}`)
  const json = await resp.json()
  const raw = json?.choices?.[0]?.message?.content?.trim() ?? '[]'
  try { return JSON.parse(raw.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trim()) } catch { return [] }
}

/**
 * Fully automated reCAPTCHA v2 solver:
 * 1. Find the reCAPTCHA iframe checkbox and click it
 * 2. If it passes immediately → done
 * 3. If an image challenge appears → use GPT-4o vision to click matching cells
 * 4. Repeat for dynamic "click new images" rounds
 */
async function solveRecaptcha(page, apiKey) {
  log('Attempting automatic reCAPTCHA solve…')

  // ── Step 1: click the checkbox iframe ──────────────────────────────────────
  const checkboxFrame = page.frameLocator('iframe[src*="recaptcha"][src*="anchor"]')
  try {
    const checkbox = checkboxFrame.locator('#recaptcha-anchor, .recaptcha-checkbox-border')
    await checkbox.waitFor({ state: 'visible', timeout: 10000 })
    await checkbox.click()
    log('Clicked reCAPTCHA checkbox')
  } catch (e) {
    logWarn(`Could not click reCAPTCHA checkbox: ${e.message}`)
    return false
  }

  await page.waitForTimeout(2500)

  // ── Step 2: check if already solved (no challenge frame) ───────────────────
  const solved = await checkboxFrame.locator('.recaptcha-checkbox-checked').count().catch(() => 0)
  if (solved > 0) {
    log('reCAPTCHA solved with checkbox alone (no challenge)')
    return true
  }

  // ── Step 3: handle image challenge ─────────────────────────────────────────
  const challengeFrame = page.frameLocator('iframe[src*="recaptcha"][src*="bframe"]')

  for (let round = 1; round <= 8; round++) {
    log(`reCAPTCHA challenge round ${round}…`)

    // Wait for the challenge to be visible
    try {
      await challengeFrame.locator('.rc-imageselect-table').waitFor({ state: 'visible', timeout: 8000 })
    } catch {
      // Challenge may have disappeared — check if solved
      const nowSolved = await checkboxFrame.locator('.recaptcha-checkbox-checked').count().catch(() => 0)
      if (nowSolved > 0) { log('reCAPTCHA solved after challenge'); return true }
      logWarn('Challenge table not found — may be solved or changed')
      break
    }

    // Screenshot the entire challenge iframe
    const challengeEl = page.locator('iframe[src*="recaptcha"][src*="bframe"]').first()
    const challengeShot = await challengeEl.screenshot()
    const b64 = challengeShot.toString('base64')

    // Ask GPT-4o which cells to click
    const cells = await askGpt4oRecaptcha(b64, apiKey)
    log(`GPT-4o selected cells: ${JSON.stringify(cells)}`)

    if (cells.length === 0) {
      // Nothing to select — try clicking Verify/Skip
      try {
        await challengeFrame.locator('#recaptcha-verify-button').click()
        log('Clicked Verify (0 cells selected)')
      } catch { logWarn('Could not click Verify') }
      await page.waitForTimeout(2000)
      continue
    }

    // Determine grid size (3×3 = 9 cells, 4×4 = 16 cells)
    const totalCells = await challengeFrame.locator('.rc-imageselect-tile').count()
    const gridSize = totalCells === 16 ? 4 : 3

    for (const cellNum of cells) {
      const idx = cellNum - 1
      if (idx < 0 || idx >= totalCells) continue
      try {
        const tile = challengeFrame.locator('.rc-imageselect-tile').nth(idx)
        await tile.click()
        await page.waitForTimeout(400)
      } catch (e) {
        logWarn(`Could not click tile ${cellNum}: ${e.message}`)
      }
    }

    // Wait for any dynamic image refreshes
    await page.waitForTimeout(1500)

    // Click Verify
    try {
      await challengeFrame.locator('#recaptcha-verify-button').click()
      log('Clicked Verify')
    } catch { logWarn('Verify button not found') }

    await page.waitForTimeout(2500)

    // Check if solved
    const nowSolved = await checkboxFrame.locator('.recaptcha-checkbox-checked').count().catch(() => 0)
    if (nowSolved > 0) {
      log('reCAPTCHA solved!')
      return true
    }

    // Check for error (wrong selection) — challenge reloads, loop continues
    const errMsg = await challengeFrame.locator('.rc-imageselect-incorrect-response, .rc-imageselect-error-select-more').isVisible().catch(() => false)
    if (errMsg) log('Wrong selection — retrying challenge…')
  }

  logWarn('Could not solve reCAPTCHA automatically after 8 rounds')
  return false
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i !== -1 ? args[i + 1] : undefined
  }

  const firstName = get('--firstName')
  const lastName = get('--lastName')
  const birthDate = get('--birthDate')
  const passport = get('--passport')
  const country = get('--country')
  const outputFile = get('--output') ?? 'i94-result.json'
  const headless = args.includes('--headless')

  if (!firstName || !lastName || !birthDate || !passport || !country) {
    console.error(
      'Usage: node autofill/fetch-i94.js \\\n' +
      '  --firstName "JOHN" --lastName "DOE" \\\n' +
      '  --birthDate "01/15/1985" \\\n' +
      '  --passport "AB1234567" \\\n' +
      '  --country "Israel" \\\n' +
      '  [--headless] [--output result.json]'
    )
    process.exit(1)
  }

  return { firstName, lastName, birthDate, passport, country, outputFile, headless }
}

// ─── GPT-4o vision agent ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an automation agent controlling a real web browser on the I-94 CBP travel history website (i94.cbp.dhs.gov).

Your goal: fill the I-94 travel history lookup form and extract the applicant's past US visit records.

FORM FLOW:
1. Homepage → click "View Travel History"
2. Terms of Service modal → use "scroll_modal_to_bottom" to scroll ALL THE WAY to the bottom → then click "I Agree" / "Agree" / "Accept"
3. Lookup form visible → use "fill_i94_form" (fills first name, last name, passport, DOB at once)
4. Then use "fill_i94_country" to pick the country from the autocomplete
5. reCAPTCHA checkbox → use "human_captcha"
6. Submit button → click it
7. Results page → use "extract"

KNOWN FIELD SELECTORS (Angular Material):
- First name:  #first-name          (formcontrolname="firstName")
- Last name:   #last-name           (formcontrolname="lastName")
- Doc number:  #document-number     (formcontrolname="number")
- Birth date:  #birth-date          (formcontrolname="dob", mat-datepicker, format MM/DD/YYYY)
- Country:     input[formcontrolname="alpha3CountryCode"]  ← autocomplete

RULES:
- Return exactly ONE action per response, as raw JSON (no markdown, no explanation).
- Actions available:

{"type":"click","label":"<visible button or link text>"}
{"type":"click_selector","selector":"<CSS selector>"}
{"type":"fill_selector","selector":"<CSS selector>","value":"<text to type>"}
{"type":"fill_i94_form"}
{"type":"fill_i94_country"}
{"type":"select_selector","selector":"<CSS selector>","value":"<option value or visible text>"}
{"type":"scroll_down"}
{"type":"scroll_modal_to_bottom"}
{"type":"wait","ms":2000}
{"type":"human_captcha"}
{"type":"extract"}
{"type":"done","error":"<message>"}

Use "fill_i94_form" as soon as the lookup form is visible — fills all text fields in one step.
Use "fill_i94_country" right after fill_i94_form — handles the autocomplete country picker.
Use "scroll_modal_to_bottom" for any modal/dialog that needs scrolling — never use scroll_down for modals.
Use "human_captcha" when you see a reCAPTCHA checkbox or image challenge — the script handles solving it automatically.
Use "extract" when the results page shows travel history data.
Use "done" with an error if the process fails.

Be decisive. Do not loop — make progress each step.`

async function askGpt4o(screenshot, personInfo, actionHistory, apiKey) {
  const historyText = actionHistory.length
    ? `\nActions taken so far:\n${actionHistory.slice(-12).map((a, i) => `  ${i + 1}. ${JSON.stringify(a)}`).join('\n')}`
    : ''

  const resp = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 256,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}`, detail: 'high' },
            },
            {
              type: 'text',
              text: [
                'Person details to fill:',
                `  First name: ${personInfo.firstName}`,
                `  Last name:  ${personInfo.lastName}`,
                `  Birth date: ${personInfo.birthDate}  (use MM/DD/YYYY format)`,
                `  Passport:   ${personInfo.passport}`,
                `  Country:    ${personInfo.country}`,
                historyText,
                '',
                'Look at the screenshot and return the next single action as JSON.',
              ].join('\n'),
            },
          ],
        },
      ],
    }),
  })

  if (!resp.ok) {
    const txt = await resp.text()
    throw new Error(`OpenAI ${resp.status}: ${txt.slice(0, 300)}`)
  }

  const json = await resp.json()
  const raw = json?.choices?.[0]?.message?.content?.trim() ?? ''

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    throw new Error(`GPT-4o returned invalid JSON: ${raw.slice(0, 200)}`)
  }
}

/** Use a separate GPT-4o call to extract the travel history from the results page */
async function extractTravelHistory(screenshot, apiKey) {
  const resp = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}`, detail: 'high' },
            },
            {
              type: 'text',
              text: [
                'This is a screenshot of the I-94 travel history results page from i94.cbp.dhs.gov.',
                '',
                'Extract ALL travel history entries from the table.',
                'For each row, capture: date, type (Arrival/Departure/etc.), and port/location.',
                '',
                'Return ONLY valid raw JSON in this exact structure (no markdown):',
                JSON.stringify({
                  success: true,
                  history: [{ date: 'MM/DD/YYYY', type: 'Arrival', location: 'JFK - JOHN F KENNEDY' }],
                }, null, 2),
                '',
                'If no travel history is visible, return:',
                JSON.stringify({ success: false, history: [] }),
              ].join('\n'),
            },
          ],
        },
      ],
    }),
  })

  if (!resp.ok) {
    const txt = await resp.text()
    throw new Error(`OpenAI extract ${resp.status}: ${txt.slice(0, 300)}`)
  }

  const json = await resp.json()
  const raw = json?.choices?.[0]?.message?.content?.trim() ?? ''
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    logWarn(`Could not parse extract response: ${raw.slice(0, 300)}`)
    return { success: false, history: [] }
  }
}

// ─── Action executor ──────────────────────────────────────────────────────────

/** Angular Material inputs ignore .fill() — need triple-click then type */
async function angularFill(page, selector, value) {
  const el = page.locator(selector).first()
  await el.waitFor({ state: 'visible', timeout: 8000 })
  await el.scrollIntoViewIfNeeded()
  await el.click({ clickCount: 3 })
  await el.fill('')
  await el.pressSequentially(value, { delay: 40 })
  await page.waitForTimeout(200)
}

async function executeAction(page, action) {
  const { type } = action

  if (type === 'fill_i94_form') {
    const p = action._person  // injected by the main loop
    log('Filling I-94 form fields directly…')

    // First name
    await angularFill(page, '#first-name, input[formcontrolname="firstName"]', p.firstName)
    log(`  firstName → ${p.firstName}`)

    // Last name
    await angularFill(page, '#last-name, input[formcontrolname="lastName"]', p.lastName)
    log(`  lastName → ${p.lastName}`)

    // Document number (passport) — formcontrolname="number", id="document-number"
    await angularFill(page, '#document-number, input[formcontrolname="number"]', p.passport)
    log(`  number → ${p.passport}`)

    // Date of birth — mat-datepicker-input, formcontrolname="dob", id="birth-date"
    // Angular Material date picker expects MM/DD/YYYY when typed directly
    const dobEl = page.locator('#birth-date, input[formcontrolname="dob"]').first()
    await dobEl.waitFor({ state: 'visible', timeout: 8000 })
    await dobEl.scrollIntoViewIfNeeded()
    await dobEl.click({ clickCount: 3 })
    await dobEl.fill('')
    await dobEl.pressSequentially(p.birthDate, { delay: 40 })
    // Press Tab to confirm the date picker value and close any calendar
    await dobEl.press('Tab')
    await page.waitForTimeout(400)
    log(`  dob → ${p.birthDate}`)

    await page.waitForTimeout(500)
    return
  }

  if (type === 'fill_i94_country') {
    const p = action._person
    log(`Filling country autocomplete → ${p.country}`)
    const input = page.locator('input[formcontrolname="alpha3CountryCode"]').first()
    await input.waitFor({ state: 'visible', timeout: 8000 })
    await input.click({ clickCount: 3 })
    await input.fill('')
    await input.pressSequentially(p.country, { delay: 60 })
    // Wait for autocomplete dropdown to appear
    await page.waitForTimeout(1200)
    // Click the first matching option
    const option = page.locator('mat-option, [role="option"]').first()
    try {
      await option.waitFor({ state: 'visible', timeout: 5000 })
      await option.click()
      log(`  Selected first autocomplete option`)
    } catch {
      // Fallback: press ArrowDown + Enter
      await input.press('ArrowDown')
      await input.press('Enter')
      log(`  Selected via keyboard`)
    }
    await page.waitForTimeout(500)
    return
  }

  if (type === 'click') {
    const el = page.getByRole('button', { name: action.label, exact: false })
      .or(page.getByRole('link', { name: action.label, exact: false }))
      .or(page.locator(`text="${action.label}"`))
      .first()
    await el.waitFor({ state: 'visible', timeout: 8000 })
    await el.scrollIntoViewIfNeeded()
    await el.click()
    await page.waitForTimeout(800)
    return
  }

  if (type === 'click_selector') {
    const el = page.locator(action.selector).first()
    await el.waitFor({ state: 'visible', timeout: 8000 })
    await el.scrollIntoViewIfNeeded()
    await el.click()
    await page.waitForTimeout(800)
    return
  }

  if (type === 'fill') {
    const el = page.getByLabel(action.label, { exact: false }).first()
    await el.waitFor({ state: 'visible', timeout: 8000 })
    await el.fill(action.value)
    await page.waitForTimeout(300)
    return
  }

  if (type === 'fill_selector') {
    const el = page.locator(action.selector).first()
    await el.waitFor({ state: 'visible', timeout: 8000 })
    await el.fill(action.value)
    await page.waitForTimeout(300)
    return
  }

  if (type === 'select') {
    const el = page.getByLabel(action.label, { exact: false }).first()
    await el.waitFor({ state: 'visible', timeout: 8000 })
    await el.selectOption(action.value)
    await page.waitForTimeout(300)
    return
  }

  if (type === 'select_selector') {
    const el = page.locator(action.selector).first()
    await el.waitFor({ state: 'visible', timeout: 8000 })
    await el.selectOption(action.value)
    await page.waitForTimeout(300)
    return
  }

  if (type === 'scroll_down') {
    await page.evaluate(() => window.scrollBy(0, 400))
    await page.waitForTimeout(500)
    return
  }

  if (type === 'scroll_element') {
    await page.locator(action.selector).first().evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await page.waitForTimeout(500)
    return
  }

  if (type === 'scroll_modal_to_bottom') {
    // Find the deepest element that is actually scrollable (scrollHeight > clientHeight)
    // and lives inside a visible modal/dialog overlay.
    const scrolled = await page.evaluate(() => {
      function isScrollable(el) {
        if (el.scrollHeight <= el.clientHeight + 2) return false
        const style = window.getComputedStyle(el)
        return /auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflow)
      }

      function scrollSlowly(el) {
        return new Promise((resolve) => {
          const step = () => {
            el.scrollTop += 150
            if (el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
              setTimeout(step, 60)
            } else {
              el.scrollTop = el.scrollHeight
              resolve()
            }
          }
          step()
        })
      }

      // Walk every element, collect scrollable ones that are currently visible
      const all = Array.from(document.querySelectorAll('*'))
      const candidates = all.filter((el) => {
        if (!isScrollable(el)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width < 50 || rect.height < 50) return false
        // Must be visible on screen
        if (rect.top > window.innerHeight || rect.bottom < 0) return false
        // Skip body/html/document-level scrollers — we want modal content
        if (el === document.body || el === document.documentElement) return false
        return true
      })

      if (candidates.length === 0) return false

      // Prefer the deepest (most specific) scrollable candidate
      candidates.sort((a, b) => b.contains(a) ? 1 : a.contains(b) ? -1 : 0)
      const target = candidates[0]
      return scrollSlowly(target).then(() => target.className || target.tagName)
    })

    if (scrolled) {
      log(`Scrolled actual scrollable modal element: ${scrolled}`)
    } else {
      // Fallback: scroll the whole page
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      log('No scrollable modal element found — scrolled page instead')
    }
    await page.waitForTimeout(800)
    return
  }

  if (type === 'wait') {
    await page.waitForTimeout(action.ms ?? 2000)
    return
  }

  logWarn(`Unknown action type: ${type}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs()

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is required.')
    process.exit(1)
  }

  log(`Launching browser (${args.headless ? 'headless' : 'headed'})…`)

  const browser = await chromium.launch({
    headless: args.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  })

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  })

  // Hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })

  const page = await context.newPage()

  const personInfo = {
    firstName: args.firstName,
    lastName: args.lastName,
    birthDate: args.birthDate,
    passport: args.passport,
    country: args.country,
  }

  log(`Person: ${personInfo.firstName} ${personInfo.lastName} | DOB: ${personInfo.birthDate} | Passport: ${personInfo.passport} | Country: ${personInfo.country}`)
  log('Navigating to i94.cbp.dhs.gov…')

  await page.goto('https://i94.cbp.dhs.gov/home', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await page.waitForTimeout(2000)

  const actionHistory = []
  let result = null

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`Step ${step}/${MAX_STEPS}`)

    const screenshot = await page.screenshot({ fullPage: false })

    let action
    try {
      action = await askGpt4o(screenshot, personInfo, actionHistory, apiKey)
    } catch (err) {
      logError('GPT-4o call failed', err)
      await page.waitForTimeout(3000)
      continue
    }

    log(`Action: ${JSON.stringify(action)}`)

    // ── Terminal conditions ─────────────────────────────────────────────────

    if (action.type === 'extract') {
      log('Extracting travel history…')
      // Take a full-page screenshot for better extraction
      const fullShot = await page.screenshot({ fullPage: true })
      result = await extractTravelHistory(fullShot, apiKey)
      log(`Extracted: success=${result.success}, entries=${result.history?.length ?? 0}`)
      break
    }

    if (action.type === 'done') {
      logWarn(`Agent finished with: ${action.error ?? '(no message)'}`)
      result = { success: false, history: [], error: action.error }
      break
    }

    // ── Automatic reCAPTCHA solve ───────────────────────────────────────────

    if (action.type === 'human_captcha') {
      await solveRecaptcha(page, apiKey)
      await page.waitForTimeout(1000)
      actionHistory.push(action)
      continue
    }

    // ── Execute action ──────────────────────────────────────────────────────

    // Inject person data for bulk-fill actions
    if (action.type === 'fill_i94_form' || action.type === 'fill_i94_country') {
      action._person = personInfo
    }

    try {
      await executeAction(page, action)
      actionHistory.push(action)
    } catch (err) {
      logWarn(`Action failed: ${err.message}`)
      actionHistory.push({ ...action, _failed: true })
      await page.waitForTimeout(1000)
    }
  }

  await browser.close()

  // ── Output ────────────────────────────────────────────────────────────────

  if (!result) {
    result = { success: false, history: [], error: 'Max steps reached without result' }
    logWarn('Max steps reached — no result extracted.')
  }

  const outputPath = path.resolve(args.outputFile)
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8')

  log('')
  log('═══════════════════════════════════════════════════════════')
  log(`Result written to: ${outputPath}`)
  log(`Success: ${result.success}`)
  log(`Entries: ${result.history?.length ?? 0}`)
  if (result.history?.length) {
    result.history.forEach((h, i) => {
      log(`  ${i + 1}. ${h.date}  ${h.type}  ${h.location}`)
    })
  }
  log('═══════════════════════════════════════════════════════════')
  log('')
}

main().catch((err) => {
  logError('Fatal error', err)
  process.exit(1)
})
