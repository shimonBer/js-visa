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
const OPENAI_TIMEOUT_MS = 60_000

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

  const resp = await fetchWithTimeout(OPENAI_URL, {
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
  const raw = json?.choices?.[0]?.message?.content?.trim() || ''

  // Reject refusals or overly long responses — a CAPTCHA answer is 4-8 chars max
  const answer = /^[A-Za-z0-9]{2,10}$/.test(raw) ? raw : ''
  if (!answer) {
    logWarn(`CAPTCHA OCR returned unusable text: "${raw.slice(0, 60)}" — will retry`)
  }
  log(`CAPTCHA answer: "${answer}"`)
  return answer
}

// ─── DS-160 known field selectors ────────────────────────────────────────────

/**
 * Map of normalized label → CSS selector for DS-160 ASP.NET form fields.
 * Keys are lower-cased, trimmed label texts (or partial matches).
 */
const DS160_KNOWN = [
  // Personal Info 1
  { match: /^surnames?$/i,                sel: 'input[id$="tbxAPSurname"]' },
  { match: /^given names?$/i,             sel: 'input[id$="tbxAPGivenName"]' },
  { match: /native alphabet/i,            sel: 'input[id$="tbxAPFulNamNatAlph"]' },
  { match: /^sex$|^gender$/i,             sel: 'select[id$="ddlSex"]' },
  { match: /marital status/i,             sel: 'select[id$="ddlMaritalStatus"]' },
  // Date of Birth split fields
  { match: /^dob day$|^day \*?$/i,        sel: 'input[id$="tbxDOBDay"], select[id$="ddlDOBDay"]' },
  { match: /^dob month$|^month \*?$/i,    sel: 'select[id$="ddlDOBMonth"], input[id$="tbxDOBMonth"]' },
  { match: /^dob year$|^year \*?$/i,      sel: 'input[id$="tbxDOBYear"], select[id$="ddlDOBYear"]' },
  // City / Place of Birth — DS-160 label on the form is just "City"
  { match: /^city\s*\*?$|city.*birth|place.*birth|birth.*city|town.*birth|city.town/i,
    sel: 'input[id$="tbxPOBCity"], input[id*="POBCity"], input[id*="BirthCity"], input[id*="POBCit"], input[id*="CityBirth"]' },
  { match: /^state\/province\s*\*?$|state.*birth|province.*birth/i,
    sel: 'input[id$="tbxAPP_POB_ST_PROVINCE"], input[id$="tbxPOBSP"], input[id*="POBSP"], input[id*="POB_ST"]' },
  { match: /country.*birth|country.*region.*birth/i, sel: 'select[id$="ddlPOBCountry"]' },
  // Personal Info 2
  { match: /country.*origin|nationality/i, sel: 'select[id$="ddlCountryOfOrigin"]' },
  { match: /national.*id/i,               sel: 'input[id$="txtNationalID"], input[id$="tbxNationalID"]' },
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
  { match: /paying.*trip|person.*paying|who.*paying|payer/i,
    sel: 'select[id$="ddlWhoIsPaying"], select[id*="ddlPayer"]' },
  { match: /relationship.*payer|payer.*relation/i,
    sel: 'select[id*="ddlPayerRelationship"], select[id*="ddlPayRelationship"]' },
  // Contact
  { match: /primary.*phone|home.*phone/i, sel: 'input[id$="tbxPhoneNumberHome"]' },
  { match: /work.*phone|employer.*phone/i, sel: 'input[id$="tbxPhoneNumberWork"]' },
  { match: /email.*address/i,             sel: 'input[id$="tbxEmailAddr"]' },
  // Passport
  { match: /passport.*number|travel.*doc.*number/i, sel: 'input[id$="tbxPassportNumber"]' },
  { match: /passport.*book/i,             sel: 'input[id$="tbxPassportBookNumber"]' },
  { match: /issue.*date|date.*issue/i,    sel: 'input[id$="tbxPassIssDt"]' },
  { match: /expir.*date|date.*expir/i,    sel: 'input[id$="tbxPassExpDt"]' },
  { match: /city.*issuance|issuance.*city/i, sel: 'input[id$="tbxPassIssCit"]' },
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
    // State/Province of birth "Does Not Apply"
    match: /state.*province|province.*state|^state\/?province/i,
    directSelectors: [
      'input[id$="cbexAPP_POB_ST_PROVINCE_NA"]',
      'input[type="checkbox"][id*="cbexAPP_POB_ST_PROVINCE"]',
      'input[type="checkbox"][id*="POB_ST_PROVINCE"]',
      'input[type="checkbox"][id*="POBSP"]',
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
]

/**
 * Try to check a "Does Not Apply" checkbox for a specific known field.
 * Searches by direct ID, then by proximity to the associated input
 * (same <tr>, same parent <table>, or nearest "Does Not Apply" label in DOM order).
 */
async function checkDoesNotApplyFor(page, fieldLabel) {
  for (const { match, directSelectors, nearInputSel } of DS160_KNOWN_CHECKBOXES) {
    if (!match.test(fieldLabel)) continue

    // 1. Try direct ID selectors — use .click() (not .check()) so that the
    //    checkbox's onclick handler (e.g. enableTbx) fires correctly.
    for (const sel of directSelectors) {
      try {
        const el = page.locator(sel).first()
        await el.waitFor({ state: 'attached', timeout: 2000 })
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

/**
 * Known radio-button questions mapped to their ASP.NET RadioButtonList IDs.
 * Index _0 = Yes, _1 = No (standard ASP.NET rendering).
 * value="Y" / value="N" is the common DS-160 pattern.
 */
const DS160_KNOWN_RADIOS = [
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
    match: /permanent resident.*other|other.*permanent resident|perm.*res/i,
    yesSelectors: ['input[id$="rblPermResOtherCntryInd_0"]', 'input[id*="rblPermResOtherCntryInd"][value="Y"]'],
    noSelectors:  ['input[id$="rblPermResOtherCntryInd_1"]', 'input[id*="rblPermResOtherCntryInd"][value="N"]'],
  },
  {
    match: /specific travel plans|made.*specific|travel plans/i,
    yesSelectors: ['input[id*="rblSpecificTravelPlans_0"]', 'input[id*="SpecificTravelPlans"][value="Y"]'],
    noSelectors:  ['input[id*="rblSpecificTravelPlans_1"]', 'input[id*="SpecificTravelPlans"][value="N"]'],
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
          await el.waitFor({ state: 'attached', timeout: 4000 })
          return el
        } catch { /* try next */ }
      }
    }
  }
  return null
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
      await el.waitFor({ state: 'visible', timeout: 3000 })
      return el
    } catch {
      // try next strategy
    }
  }

  // Last-resort: scan table rows for a cell containing the label text,
  // then grab the first input/select in the adjacent cell.
  if (label) {
    const labelSnippet = label.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const rowSel of [
      `tr:has-text("${labelSnippet}")`,
      `tr:has(td:has-text("${labelSnippet}"))`,
    ]) {
      try {
        const row = page.locator(rowSel).first()
        await row.waitFor({ state: 'attached', timeout: 2000 })
        for (const inputSel of ['input[type="text"]', 'input[type="number"]', 'select', 'textarea']) {
          try {
            const inp = row.locator(inputSel).first()
            await inp.waitFor({ state: 'attached', timeout: 1000 })
            return inp
          } catch { /* try next */ }
        }
      } catch { /* try next */ }
    }
  }

  throw new Error(`Element not found — label="${label}" text="${text}"`)
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
async function clickRadioForQuestion(page, questionLabel, value) {
  const isYes      = /^y(es)?$/i.test(value.trim())
  const targetText = isYes ? 'Yes' : 'No'

  // Helper: does a text string contain the first ~25 chars of the question?
  const questionSnippet = questionLabel.slice(0, 25).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

  // ── Strategy 4: getByLabel last resort (least accurate) ─────────────────────
  const fallback = page.getByLabel(targetText, { exact: true }).first()
  if (await fallback.count() > 0) {
    await fallback.scrollIntoViewIfNeeded().catch(() => {})
    await fallback.click()
    return
  }

  throw new Error(`Radio not found for question="${questionLabel}" value="${value}"`)
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

  if (type === 'fillDate' || (type === 'fill' && /\d{1,2}\/\d{1,2}\/\d{4}/.test(value) && /date/i.test(label))) {
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

    // Determine field selectors based on label context
    const isSpouseDOB   = /spouse/i.test(label)
    const isFatherDOB   = /father/i.test(label)
    const isMotherDOB   = /mother/i.test(label)
    const isArrivalDate = /arrival|intended.*date|date.*arrival/i.test(label)

    let daySelectors, monthSelectors, yearSelectors

    if (isArrivalDate) {
      // Intended Date of Arrival: Day=dropdown (value="1"–"31"), Month=dropdown (3-letter), Year=text input
      daySelectors   = [
        'select[id$="ddlTRAVEL_DTEDay"]',
        'select[id*="ddlTravelDayOfArrival"]',
        'select[id*="ArrivalDay"]',
      ]
      monthSelectors = [
        'select[id$="ddlTRAVEL_DTEMonth"]',
        'select[id*="ddlTravelMonthOfArrival"]',
        'select[id*="ArrivalMonth"]',
      ]
      yearSelectors  = [
        'input[id$="tbxTRAVEL_DTEYear"]',
        'input[id*="tbxTravelYearOfArrival"]',
        'input[id*="ArrivalYear"]',
      ]
    } else {
      const dayIdHint   = isSpouseDOB ? 'SpsDOBDay'   : isFatherDOB ? 'FthrDOBDay'   : isMotherDOB ? 'MthrDOBDay'   : 'DOBDay'
      const monthIdHint = isSpouseDOB ? 'SpsDOBMonth' : isFatherDOB ? 'FthrDOBMonth' : isMotherDOB ? 'MthrDOBMonth' : 'DOBMonth'
      const yearIdHint  = isSpouseDOB ? 'SpsDOBYear'  : isFatherDOB ? 'FthrDOBYear'  : isMotherDOB ? 'MthrDOBYear'  : 'DOBYear'
      daySelectors   = [`input[id$="${dayIdHint}"]`,   `select[id$="${dayIdHint}"]`,   'input[id$="tbxDOBDay"]',   'select[id$="ddlDOBDay"]']
      monthSelectors = [`select[id$="${monthIdHint}"]`, `input[id$="${monthIdHint}"]`, 'select[id$="ddlDOBMonth"]', 'input[id$="tbxDOBMonth"]']
      yearSelectors  = [`input[id$="${yearIdHint}"]`,   `select[id$="${yearIdHint}"]`, 'input[id$="tbxDOBYear"]',  'select[id$="ddlDOBYear"]']
    }

    async function setDateField(selectors, ...candidates) {
      const vals = candidates.filter(Boolean)
      for (const sel of selectors) {
        try {
          const el = page.locator(sel).first()
          await el.waitFor({ state: 'attached', timeout: 4000 })
          const tag = await el.evaluate(e => e.tagName.toLowerCase())
          if (tag === 'select') {
            for (const v of vals) {
              try { await el.selectOption({ label: v }); return } catch {}
              try { await el.selectOption({ value: v }); return } catch {}
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
      for (const sel of allSelects) {
        try {
          if (!await sel.isVisible()) continue
          const opts = await sel.locator('option').all()
          if (opts.length < 10) continue
          const texts = await Promise.all(opts.slice(1, 4).map(o => o.textContent()))
          const looksLikeMonths = texts.some(t => /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(t || ''))
          if (looksLikeMonths) return sel
        } catch { /* skip */ }
      }
      return null
    }

    // Day: try zero-padded ("05"), plain number ("5"), and string number
    const dayResult   = await setDateField(daySelectors, day, parseInt(day, 10).toString())
    // Month: try full name ("December"), 3-letter abbrev ("DEC"), and numeric ("12")
    const monthResult = await setDateField(monthSelectors, monthName, monthAbbrev, month)

    if (monthResult === null) {
      // Fallback: find month select by scanning option text content
      const monthSel = await findMonthSelectByOptions()
      if (monthSel) {
        try { await monthSel.selectOption({ label: monthName }) } catch {}
        try { await monthSel.selectOption({ label: monthAbbrev }) } catch {}
        try { await monthSel.selectOption({ value: month }) } catch {}
        log(`Month set via option-content fallback: "${monthAbbrev}"`)
      } else {
        throw new Error(`Date sub-field (month) not found — tried: ${monthSelectors.join(', ')} and option-content scan`)
      }
    }

    await setDateField(yearSelectors, year, year)
    return
  }

  if (type === 'fill') {
    // For native alphabet field: uncheck "Does Not Apply" first if it's checked,
    // because a checked checkbox disables the input making fill silently fail.
    if (/native alphabet/i.test(label || '')) {
      try {
        const cb = page.locator('input[type="checkbox"]').filter({ hasText: '' }).locator('xpath=../..').locator('input[type="checkbox"]')
        // Simpler: find checkbox near the native alphabet input
        const nativeCb = page.locator('input[id$="cbxAPFulNamNatAlph"], input[id*="NatAlph"][type="checkbox"]').first()
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

    const el = await findElement(page, { label })
    await el.scrollIntoViewIfNeeded().catch(() => {})
    // If the resolved element is a <select>, delegate to selectOption instead of fill
    const elTag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => 'input')
    if (elTag === 'select') {
      try { await el.selectOption({ label: value }); return } catch {}
      try { await el.selectOption({ value }); return } catch {}
      throw new Error(`Could not selectOption on <select> — label="${label}" value="${value}"`)
    }
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
    return
  }

  if (type === 'selectOption') {
    // If GPT used selectOption for a date field, redirect to fill (triggers fillDate logic)
    if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(value) && /date|birth|dob/i.test(label || '')) {
      return executeAction(page, { type: 'fill', label, value })
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

    // First try as a <select> element
    try {
      const el = await findElement(page, { label })
      const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => 'select')
      if (tag === 'select') {
        try { await el.selectOption({ label: value }); return } catch {}
        try { await el.selectOption({ value }); return } catch {}
      }
      // Found an input instead of a select — scan nearby selects in the same row
      const row = el.locator('xpath=ancestor::tr[1]')
      const nearSelect = row.locator('select').first()
      if (await nearSelect.count() > 0) {
        try { await nearSelect.selectOption({ label: value }); return } catch {}
        try { await nearSelect.selectOption({ value }); return } catch {}
      }
    } catch { /* fall through to radio */ }
    // Fallback: treat as radio (e.g. agent used selectOption for a Yes/No field)
    await clickRadioForQuestion(page, label, value)
    return
  }

  if (type === 'radio') {
    await clickRadioForQuestion(page, label, value)
    return
  }

  if (type === 'check') {
    const checkLabel = label || text || ''

    // Guard: block "Does Not Apply / Technology Not Available" ONLY when it targets
    // the native-alphabet field — check only that specific input, not the whole page.
    // (Checking all inputs was blocking State/Province when Hebrew was present elsewhere.)
    if (/does not apply|technology not available/i.test(checkLabel)) {
      try {
        const nativeEl = page.locator('input[id$="tbxAPFulNamNatAlph"]').first()
        const nativeVal = await nativeEl.inputValue().catch(() => '')
        if (nativeVal && /[^\x00-\x7F]/.test(nativeVal)) {
          // Only block if the action is actually targeting the native-alphabet row
          const fieldHintRaw = action.fieldLabel || action.for || ''
          if (!fieldHintRaw || /native|alphabet|natAlph/i.test(fieldHintRaw)) {
            log(`⚠️  Blocked "Does Not Apply" — native-alphabet input has value: "${nativeVal.slice(0, 30)}"`)
            return
          }
        }
      } catch { /* native field not present on this page, continue */ }
    }

    // Try known field-specific "Does Not Apply" first (e.g. State/Province)
    const fieldHint = action.fieldLabel || action.for || checkLabel
    if (fieldHint) {
      const handled = await checkDoesNotApplyFor(page, fieldHint)
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
    throw new Error(`Checkbox not found for label="${checkLabel}"`)
  }

  if (type === 'click') {
    // Guard: block clicking "Does Not Apply" / "Technology Not Available" if
    // Block clicking "Does Not Apply" / "Technology Not Available" only when
    // the native-alphabet input has a value (same scoped guard as the check handler).
    const clickTarget = (text || label || '').toLowerCase()
    if (/does not apply|technology not available/i.test(clickTarget)) {
      try {
        const nativeEl = page.locator('input[id$="tbxAPFulNamNatAlph"]').first()
        const nativeVal = await nativeEl.inputValue().catch(() => '')
        if (nativeVal) {
          log(`⚠️  Blocked click on "Does Not Apply" — native alphabet field has value: "${nativeVal.slice(0, 30)}"`)
          return
        }
      } catch { /* field not present, continue */ }
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
{"type":"radio","label":"<question label text>","value":"Yes OR No"}
{"type":"check","label":"<exact visible checkbox or label text>"}
{"type":"click","text":"<exact visible button or link text>"}
{"type":"solveCaptcha"}
{"type":"wait"}
{"type":"done"}

RULES:
- Output ONLY one action per response
- Use the EXACT visible text of the label as it appears on the current screenshot
- CRITICAL: Yes/No questions on the DS-160 are RADIO BUTTONS, not dropdowns. Always use {"type":"radio"} for Yes/No questions, NEVER use {"type":"fill"} or {"type":"selectOption"} for them
- Examples of radio button questions: "Have you ever used other names?", "Do you have a telecode that represents your name?", "Are you a permanent resident?", "Have you ever been in the United States?", etc.
- IMPORTANT: For radio actions, copy the "label" text EXACTLY as it appears on screen. The "value" must be exactly "Yes" or "No" (capitalised).
- Do NOT skip any Yes/No question — answer every one before clicking Next
- Use {"type":"selectOption"} for actual <select> dropdown menus. Key dropdown fields: Sex (use "MALE" or "FEMALE"), Marital Status (use "SINGLE", "MARRIED", "WIDOWED", "DIVORCED", "SEPARATED"), Country, State
- NEVER use {"type":"fill"} for Sex or Marital Status — these are <select> dropdowns, always use {"type":"selectOption"}
- For "Does Not Apply" checkboxes: {"type":"check","label":"Does Not Apply"}
- After selecting a dropdown or clicking a radio button, output {"type":"wait"} as your NEXT action to let dependent fields render
- For the security question setup: select "WHAT WAS YOUR HOME PHONE NUMBER WHEN YOU WERE A CHILD?" and enter answer "049824393"
- If you see a CAPTCHA image on the page: output {"type":"solveCaptcha"}
- If a field has N/A in the applicant data: check "Does Not Apply" if the checkbox is present, otherwise skip
- CRITICAL: For "Full Name in Native Alphabet" — if the applicant data contains a native-alphabet name (Hebrew, Arabic, or any non-Latin script), you MUST fill it using {"type":"fill"} and you MUST NEVER output {"type":"check"} or {"type":"click"} targeting "Does Not Apply" or "Technology Not Available" for this field — not before, not after, not ever. The checkbox must stay unchecked. After filling, move immediately to the next field. Only check "Does Not Apply" for this field if the applicant data explicitly has N/A or is completely absent for the native name.
- If a field has ❗ MISSING: skip it (leave blank)
- Click "Next" or "Continue" only after ALL visible fields on the current section are filled. Use the EXACT visible button text (e.g. "Next: Personal 2", "Next: Work/Education", "Next: Security") — never shorten it to just "Next"
- NEVER output {"type":"done"} — the form is in development mode and must never be submitted
- NEVER click any button containing the words: Submit, Sign and Submit, Final Submit
- If you are on a preview/review screen (no editable fields visible): click the Next or Continue button
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
  * "Person/Organization Paying for Your Trip" is a <select> dropdown — use {"type":"selectOption"} with the exact option text: "Self", "Other Person", "Present Employer", "Employer in the U.S.", or "Other Company/Organization". Most likely "Self". After selecting, output {"type":"wait"} — if not Self, additional fields will appear
  * ZIP Code field in U.S. address — if unknown or N/A, simply skip it (leave blank, no "Does Not Apply" checkbox exists for it)
- Previous U.S. Travel page — all four questions are radio buttons, use {"type":"radio"} with the label copied EXACTLY as it appears on screen:
  * "Have you ever been in the United States?" → Yes/No
  * "Have you ever been issued a U.S. Visa?" → Yes/No; if Yes, fill visa number, issue date, expiry date
  * "Have you ever been refused a U.S. Visa, or been refused admission to the United States, or withdrawn your application for admission at the port of entry?" → Yes/No; if Yes, fill explanation
  * "Has anyone ever filed an immigrant petition on your behalf with the United States Citizenship and Immigration Services?" → Yes/No; if Yes, fill explanation
  * If a field value is N/A in the applicant data and there is no "Does Not Apply" checkbox visible, skip the field entirely`

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

  const resp = await fetchWithTimeout(OPENAI_URL, {
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

// ─── Page context detection ──────────────────────────────────────────────────

/**
 * Detect which DS-160 page/section the browser is currently on.
 *
 * PRIMARY: URL-based detection — each DS-160 section has a distinct .aspx filename.
 * FALLBACK: page heading text (h2/h3/legend), only if URL gives no match.
 * We deliberately avoid scanning the full body text because DS-160 keeps hidden
 * fields from previous pages in the DOM, causing false-positive matches.
 */
async function detectCurrentPageContext(page) {
  try {
    const url = page.url().toLowerCase()

    // ── URL-based detection (most reliable) ─────────────────────────────────
    if (url.includes('default.aspx'))          return 'captcha'
    if (url.includes('disclaimer'))             return 'disclaimer'
    if (url.includes('appsecurityquestion') ||
        url.includes('securityquestion'))       return 'security_question'
    if (url.includes('personalinfo1') ||
        url.includes('personal_info1'))         return 'personal1'
    if (url.includes('personalinfo2') ||
        url.includes('personal_info2'))         return 'personal2'
    if (url.includes('travelinfo') ||
        url.includes('travel_info'))            return 'travel'
    if (url.includes('travelcompanion') ||
        url.includes('travel_companion'))       return 'companions'
    if (url.includes('previoustravel') ||
        url.includes('previous_travel'))        return 'prev_travel'
    if (url.includes('addressphone') ||
        url.includes('address_phone'))          return 'address'
    if (url.includes('passport'))               return 'passport'
    if (url.includes('contactpeople') ||
        url.includes('contact'))                return 'contact'
    if (url.includes('familyinfo') ||
        url.includes('family'))                 return 'family'
    if (url.includes('workeducation') ||
        url.includes('work_education'))         return 'work_edu'
    if (url.includes('securityandbackground') ||
        url.includes('security_background'))    return 'security'
    if (url.includes('review') ||
        url.includes('preview'))                return 'review'

    // ── Heading-based fallback (avoid full body scan) ────────────────────────
    for (const sel of ['h2', 'h3', 'legend', '.step-title']) {
      try {
        const text = (await page.locator(sel).first().textContent({ timeout: 500 }))?.toLowerCase() || ''
        if (text.includes('personal information 1'))  return 'personal1'
        if (text.includes('personal information 2'))  return 'personal2'
        if (text.includes('travel information'))      return 'travel'
        if (text.includes('travel companion'))        return 'companions'
        if (text.includes('previous u.s. travel') ||
            text.includes('previous us travel'))      return 'prev_travel'
        if (text.includes('address'))                 return 'address'
        if (text.includes('passport'))                return 'passport'
        if (text.includes('work') || text.includes('education')) return 'work_edu'
        if (text.includes('security') && text.includes('background')) return 'security'
        if (text.includes('review') || text.includes('preview'))      return 'review'
      } catch { /* try next */ }
    }

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Extract only the section(s) of the translated text relevant to the current page.
 * Falls back to the full text if context is unknown.
 */
function filterTranslatedText(translatedText, pageContext) {
  const SECTION_PATTERNS = {
    personal1:    /PERSONAL INFORMATION 1[\s\S]*?(?=\nPERSONAL INFORMATION 2|\n🟦|$)/i,
    personal2:    /PERSONAL INFORMATION 2[\s\S]*?(?=\n🟦|$)/i,
    travel:       /🟦 TRAVEL INFORMATION[\s\S]*?(?=\n🟦|$)/i,
    companions:   /🟦 TRAVEL COMPANIONS[\s\S]*?(?=\n🟦|$)/i,
    prev_travel:  /🟦 PREVIOUS U\.?S\.? TRAVEL[\s\S]*?(?=\n🟦|$)/i,
    address:      /🟦 ADDRESS AND PHONE[\s\S]*?(?=\n🟦|$)/i,
    passport:     /🟦 PASSPORT[\s\S]*?(?=\n🟦|$)/i,
    contact:      /🟦 CONTACT[\s\S]*?(?=\n🟦|$)/i,
    family:       /🟦 FAMILY[\s\S]*?(?=\n🟦|$)/i,
    work_edu:     /🟦 WORK.*EDUCATION[\s\S]*?(?=\n🟦|$)/i,
    security:     /🟦 SECURITY[\s\S]*?(?=\n🟦|$)/i,
  }

  const pattern = SECTION_PATTERNS[pageContext]
  if (!pattern) return translatedText  // unknown page — send everything

  const match = translatedText.match(pattern)
  return match ? match[0].trim() : translatedText
}

// ─── Main agent loop ─────────────────────────────────────────────────────────

const MAX_STEPS = 500
const MAX_CONSECUTIVE_ERRORS = 5
// Per-page stall limits — longer for dense sections like Travel and Security
const PAGE_STALL_LIMITS = {
  travel:           60,
  security:         60,
  work_edu:         50,
  family:           50,
  address:          40,
  personal1:        35,
  personal2:        35,
  prev_travel:      35,
  passport:         35,
  contact:          30,
  companions:       25,
  security_question:20,
  captcha:          15,
  disclaimer:       10,
  review:           20,
  unknown:          40,
}

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
  // Track the native alphabet value so we can restore it if the page clears it
  let nativeAlphabetValue = ''
  // Stall detection
  let currentPageContext = 'unknown'
  let stepsOnCurrentPage = 0

  log('Agent loop started.')

  for (let step = 1; step <= MAX_STEPS; step++) {
    log(`Step ${step}/${MAX_STEPS}`)

    // Detect and log section changes
    await detectAndLogSection(page)

    // ── Page context + stall detection ──────────────────────────────────────
    const pageContext = await detectCurrentPageContext(page)
    if (pageContext === currentPageContext) {
      stepsOnCurrentPage++
    } else {
      if (currentPageContext !== 'unknown') {
        log(`📄 Page changed: "${currentPageContext}" → "${pageContext}" (after ${stepsOnCurrentPage} steps)`)
      }
      currentPageContext = pageContext
      stepsOnCurrentPage = 1
    }

    const stallLimit = PAGE_STALL_LIMITS[pageContext] ?? 40
    if (stepsOnCurrentPage > stallLimit) {
      throw new Error(
        `⛔ Stall detected — stuck on page "${pageContext}" for ${stepsOnCurrentPage} consecutive steps ` +
        `(limit: ${stallLimit}). This usually means a CAPTCHA was not solved, a required field was missed, ` +
        `or a navigation button was not clicked. Aborting.`
      )
    }

    log(`[page: ${pageContext}, step-on-page: ${stepsOnCurrentPage}]`)

    // Filter translated text to only the current page's section
    const relevantText = filterTranslatedText(translatedText, pageContext)

    // Screenshot
    const screenshot = await page.screenshot({ fullPage: false })

    let action
    try {
      action = await askAgent(screenshot, relevantText, actionHistory, apiKey)
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

      // After filling CAPTCHA, click the submit/continue button so the page advances.
      // Without this, GPT loops on solveCaptcha forever.
      if (captchaSuccess) {
        try {
          await page.waitForTimeout(400)
          const submitBtn = page.locator(
            'input[type="submit"], input[type="image"], button[type="submit"],' +
            'a:has-text("New Application"), a:has-text("Start"), ' +
            'input[value*="New" i], input[value*="Start" i], input[value*="Submit" i]'
          ).first()
          if (await submitBtn.isVisible({ timeout: 2000 })) {
            await submitBtn.click()
            log('Clicked CAPTCHA submit button')
            try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }) } catch {}
          }
        } catch { /* no submit button visible — GPT will handle navigation */ }
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

    // After filling native alphabet: inject a browser-side guard that runs every
    // 200ms inside the page. It keeps the checkbox unchecked and the value restored
    // no matter what triggers the change (agent action, page JS, postback, etc.).
    if (action.type === 'fill' && /native alphabet/i.test(action.label || '') && action.value) {
      nativeAlphabetValue = action.value
      await page.evaluate((val) => {
        if (window.__nativeGuardInterval) clearInterval(window.__nativeGuardInterval)
        window.__nativeGuardValue = val
        window.__nativeGuardInterval = setInterval(() => {
          // Find by known ID suffix pattern
          const input = document.querySelector(
            '[id$="tbxAPFulNamNatAlph"], [id*="FulNamNatAlph"]'
          )
          const cb = document.querySelector(
            '[id$="cbxAPFulNamNatAlph"], [id*="NatAlph"][type="checkbox"]'
          )
          // 1. If checkbox is checked — uncheck it immediately
          if (cb && cb.checked) {
            cb.checked = false
            cb.dispatchEvent(new Event('change', { bubbles: true }))
          }
          // 2. If input was disabled — re-enable it
          if (input && input.disabled) {
            input.disabled = false
          }
          // 3. If input value was cleared — restore it
          if (input && !input.value && window.__nativeGuardValue) {
            input.value = window.__nativeGuardValue
            input.dispatchEvent(new Event('input',  { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }, 200)
      }, action.value).catch(() => {})
      log(`🔒 Native alphabet guard active for: "${action.value}"`)
    }

    // Wait for page to settle after every action — guard against navigation/close
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
    } catch { /* continue */ }
    try { await page.waitForTimeout(800) } catch { /* browser navigated */ }
  }

  log('Agent loop finished.')
}
