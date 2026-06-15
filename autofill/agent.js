/**
 * DS-160 GPT-4o Vision Agent
 *
 * At each step:
 *   1. Screenshot the current page
 *   2. Send screenshot + applicant data + action history to GPT-4o
 *   3. GPT-4o returns ONE structured action
 *   4. Execute the action with Playwright
 *   5. Wait for the page to settle, then repeat
 *
 * ⛔ DEVELOPMENT MODE: The form is NEVER submitted.
 *    Any action that would click Submit / Sign and Submit is blocked.
 */

import fs from 'fs'
import path from 'path'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

// Phrases that indicate a final-submission button — always blocked
const SUBMIT_BLOCKLIST = [
  'sign and submit',
  'submit application',
  'submit this application',
  'final submit',
  'submit now',
]

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

/**
 * Crops the CAPTCHA image from the page, sends it to GPT-4o, and returns
 * the text. Retries up to maxRetries times if the form rejects the answer.
 */
export async function solveCaptchaOnPage(page, apiKey) {
  log('Solving CAPTCHA via GPT-4o OCR…')

  // Common CAPTCHA image selectors on the DS-160 site
  const captchaSelectors = [
    'img[src*="captcha" i]',
    'img[src*="Captcha" i]',
    'img[id*="captcha" i]',
    'img[id*="Captcha" i]',
    '#ctl00_SiteContentPlaceHolder_ucLocationSearch_CaptchaImage',
    '#ctl00_SiteContentPlaceHolder_ucAppSecurityQuestion_CaptchaImage',
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
    // Fallback: full-page screenshot
    logWarn('Could not locate CAPTCHA image element — using full-page screenshot')
    captchaEl = null
  }

  const imgBuffer = captchaEl
    ? await captchaEl.screenshot()
    : await page.screenshot({ fullPage: false })

  const b64 = imgBuffer.toString('base64')

  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 32,
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
              text: 'This is a CAPTCHA image from a U.S. government visa website. Read the exact characters shown. Preserve uppercase and lowercase exactly as displayed. Reply with ONLY the characters — no spaces, no explanation, no punctuation.',
            },
          ],
        },
      ],
    }),
  })

  const json = await resp.json()
  const answer = json?.choices?.[0]?.message?.content?.trim() || ''
  log(`CAPTCHA answer: "${answer}"`)
  return answer
}

// ─── Element executor ────────────────────────────────────────────────────────

/**
 * Find an element by label / text using multiple Playwright strategies.
 * Returns the first locator that resolves to a visible element, or throws.
 */
async function findElement(page, { label, text, role }) {
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

  for (const strat of strategies) {
    try {
      const el = strat()
      await el.waitFor({ state: 'visible', timeout: 3000 })
      return el
    } catch {
      // try next strategy
    }
  }

  throw new Error(`Element not found — label="${label}" text="${text}"`)
}

/**
 * Execute a single agent action on the Playwright page.
 * Throws if the action is a blocked submission attempt.
 */
export async function executeAction(page, action) {
  const { type, label, text, value } = action

  // ⛔ Hard block — never submit the form
  if (type === 'click' && text) {
    const lower = text.toLowerCase()
    for (const blocked of SUBMIT_BLOCKLIST) {
      if (lower.includes(blocked)) {
        throw new Error(`⛔ BLOCKED: Attempted to click "${text}" — form submission is disabled in development mode.`)
      }
    }
  }

  if (type === 'fill') {
    const el = await findElement(page, { label })
    await el.fill(value)
    return
  }

  if (type === 'selectOption') {
    const el = await findElement(page, { label })
    await el.selectOption({ label: value })
    return
  }

  if (type === 'check') {
    // "Does Not Apply" checkboxes are usually near the field label
    try {
      const el = await findElement(page, { label: label || text })
      await el.check()
    } catch {
      // Fallback: find any visible unchecked checkbox whose nearby text matches
      const checkboxes = await page.locator('input[type="checkbox"]').all()
      for (const cb of checkboxes) {
        try {
          const parentText = await cb.locator('xpath=..').textContent()
          if (parentText && parentText.toLowerCase().includes((label || text).toLowerCase())) {
            await cb.check()
            return
          }
        } catch { /* skip */ }
      }
      throw new Error(`Checkbox not found for label="${label}"`)
    }
    return
  }

  if (type === 'click') {
    const el = await findElement(page, { text, label })
    await el.click()
    return
  }

  if (type === 'wait') {
    await page.waitForTimeout(1500)
    return
  }
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

// ─── GPT-4o agent call ───────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are a browser automation agent filling a U.S. DS-160 nonimmigrant visa application form on behalf of an applicant.

You will receive:
1. A screenshot of the current page
2. The applicant's complete DS-160 data (translated English text)
3. A log of the last actions you have already executed

Your task: output EXACTLY ONE next action as a JSON object. No explanation. No markdown. Pure JSON only.

ACTION SCHEMA — choose exactly one:
{"type":"fill","label":"<exact visible label text on page>","value":"<text to type>"}
{"type":"selectOption","label":"<exact visible label text on page>","value":"<option text to select>"}
{"type":"check","label":"<exact visible checkbox or label text>"}
{"type":"click","text":"<exact visible button or link text>"}
{"type":"solveCaptcha"}
{"type":"wait"}
{"type":"done"}

RULES:
- Output ONLY one action per response
- Use the EXACT visible text of the label as it appears on the current screenshot
- For "Does Not Apply" checkboxes: {"type":"check","label":"Does Not Apply"}
- After selecting a dropdown or checking a checkbox, output {"type":"wait"} as your NEXT action to let dependent fields render
- For the security question setup: select "WHAT WAS YOUR HOME PHONE NUMBER WHEN YOU WERE A CHILD?" and enter answer "049824393"
- If you see a CAPTCHA image on the page: output {"type":"solveCaptcha"}
- If a field has N/A in the applicant data: check "Does Not Apply" if the checkbox is present, otherwise skip
- If a field has ❗ MISSING: skip it (leave blank)
- Click "Next" or "Continue" only after ALL visible fields on the current section are filled
- NEVER output {"type":"done"} — the form is in development mode and must never be submitted
- NEVER click any button containing the words: Submit, Sign and Submit, Final Submit
- If you are on a preview/review screen (no editable fields visible): click the Next or Continue button
- Fill fields in top-to-bottom, left-to-right order as they appear on screen`

/**
 * Ask GPT-4o what the next action should be.
 * Returns a parsed action object.
 */
export async function askAgent(screenshotBuffer, translatedText, actionHistory, apiKey) {
  // Keep history short to avoid excessive token use (last 30 actions)
  const recentHistory = actionHistory.slice(-30)
  const historyText = recentHistory.length
    ? '\n\nACTIONS ALREADY TAKEN (most recent last):\n' +
      recentHistory.map((a, i) => `${i + 1}. ${JSON.stringify(a)}`).join('\n')
    : '\n\nNo actions taken yet — this is the first step.'

  const b64 = screenshotBuffer.toString('base64')

  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 128,
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
  const raw = json?.choices?.[0]?.message?.content?.trim() || ''

  // Strip markdown code fences if model wraps response
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    throw new Error(`Agent returned non-JSON: ${raw.slice(0, 200)}`)
  }
}

// ─── Main agent loop ─────────────────────────────────────────────────────────

const MAX_STEPS = 500
const MAX_CONSECUTIVE_ERRORS = 5

/**
 * Run the agent loop until it signals done (or reaches step limit).
 *
 * @param {import('playwright').Page} page
 * @param {string} translatedText
 * @param {string} apiKey
 */
export async function runAgent(page, translatedText, apiKey) {
  const actionHistory = []
  let consecutiveErrors = 0

  log('Agent loop started.')

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`Step ${step}/${MAX_STEPS}`)

    // Detect and log section changes
    await detectAndLogSection(page)

    // Screenshot
    const screenshot = await page.screenshot({ fullPage: false })

    let action
    try {
      action = await askAgent(screenshot, translatedText, actionHistory, apiKey)
      consecutiveErrors = 0
    } catch (err) {
      consecutiveErrors++
      logError(`Agent call failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`, err)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new Error('Too many consecutive agent errors — aborting.')
      }
      await page.waitForTimeout(2000)
      continue
    }

    logAction(action)

    // Guard: done is blocked in dev mode
    if (action.type === 'done') {
      log('⛔ Agent returned "done" — STOPPING without submitting (development mode).')
      log('Form fill complete. Review the form in the browser window, then close it manually.')
      break
    }

    // Handle CAPTCHA
    if (action.type === 'solveCaptcha') {
      let captchaText = ''
      let captchaSuccess = false

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          captchaText = await solveCaptchaOnPage(page, apiKey)
          // Find the captcha input and fill it
          const captchaInputSelectors = [
            'input[name*="captcha" i]',
            'input[id*="captcha" i]',
            'input[name*="Captcha" i]',
            '#ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha',
            '#ctl00_SiteContentPlaceHolder_ucAppSecurityQuestion_txtcaptcha',
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
          captchaSuccess = true
          break
        } catch (err) {
          logWarn(`CAPTCHA attempt ${attempt} failed: ${err.message}`)
          await page.waitForTimeout(1000)
        }
      }

      if (!captchaSuccess) {
        logError('All 3 CAPTCHA attempts failed')
      }

      actionHistory.push({ type: 'solveCaptcha', answer: captchaText })
      await page.waitForTimeout(500)
      continue
    }

    // Execute action
    try {
      await executeAction(page, action)
      actionHistory.push(action)
    } catch (err) {
      if (err.message.startsWith('⛔ BLOCKED')) {
        log(err.message)
        log('Autofill has stopped at the submission boundary. Form is NOT submitted.')
        break
      }
      consecutiveErrors++
      logError(`Action execution failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${err.message}`, err)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new Error('Too many consecutive action failures — aborting.')
      }
      actionHistory.push({ type: '_error', ...action, error: err.message })
    }

    // Wait for page to settle after every action
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 })
    } catch {
      // networkidle timeout is fine — just continue
      await page.waitForTimeout(600)
    }
  }

  log('Agent loop finished.')
}
