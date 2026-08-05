/**
 * I-94 Travel History Lookup Service
 *
 * Runs a headed Playwright browser (via xvfb on Railway) to fetch
 * travel history from i94.cbp.dhs.gov.
 *
 * POST /lookup
 *   Body: { firstName, lastName, birthDate, passportNumber, country }
 *   Auth: Authorization: Bearer <I94_SECRET>
 *   Returns: { success, history: [{date, type, location}] }
 *
 * Env vars:
 *   PORT          (default 3001)
 *   I94_SECRET    shared secret to protect the endpoint
 *   OPENAI_API_KEY  (optional) used only if vision fallback extraction is needed
 */

import express from 'express'
import cors from 'cors'
import { chromium } from 'playwright'
import { I94_MODEL } from './openaiModels.js'

const PORT   = process.env.PORT ?? 3001
const SECRET = process.env.I94_SECRET ?? ''

const CBP_URL = 'https://i94.cbp.dhs.gov'

const app = express()
app.use(express.json())
app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// ─── Auth middleware ──────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path === '/health') return next()
  if (!SECRET) return next()               // no secret configured → open
  const auth = req.headers.authorization ?? ''
  if (auth === `Bearer ${SECRET}`) return next()
  res.status(401).json({ error: 'Unauthorized' })
})

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString().slice(11, 23) }
function log(msg) { console.log(`[${ts()}] ${msg}`) }

async function angularFill(page, selector, value) {
  const el = page.locator(selector).first()
  await el.waitFor({ state: 'visible', timeout: 10000 })
  await el.scrollIntoViewIfNeeded()
  await el.click({ clickCount: 3 })
  await el.fill('')
  await el.pressSequentially(value, { delay: 35 })
  await page.waitForTimeout(150)
}

// Country name → ISO 3166-1 alpha-3
const ALPHA3 = {
  israel:'ISR', usa:'USA', 'united states':'USA', france:'FRA', germany:'DEU',
  'united kingdom':'GBR', uk:'GBR', canada:'CAN', australia:'AUS', india:'IND',
  china:'CHN', japan:'JPN', brazil:'BRA', mexico:'MEX', russia:'RUS',
  'south korea':'KOR', korea:'KOR', italy:'ITA', spain:'ESP', netherlands:'NLD',
  turkey:'TUR', sweden:'SWE', norway:'NOR', denmark:'DNK', finland:'FIN',
  poland:'POL', argentina:'ARG', colombia:'COL', philippines:'PHL', thailand:'THA',
}
function toAlpha3(c) {
  return ALPHA3[(c??'').toLowerCase().trim()] ?? c.toUpperCase().slice(0,3)
}

// Normalize birthDate: accept MM/DD/YYYY or YYYY-MM-DD → MM/DD/YYYY
function normalizeDob(dob) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const [y,m,d] = dob.split('-')
    return `${m}/${d}/${y}`
  }
  return dob
}

// ─── reCAPTCHA image challenge solver ────────────────────────────────────────

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

async function askRecaptchaModel(screenshotB64, instructionText = '') {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) { log('No OPENAI_API_KEY — cannot solve image challenge'); return [] }

  const prompt = instructionText
    ? `This is a reCAPTCHA image challenge. The instruction says: "${instructionText}".\nClick all grid cells that contain the target object mentioned in the instruction.\nNumber the cells left-to-right, top-to-bottom starting at 1 (e.g. 3×3 grid has 9 cells, 4×4 has 16).\nReply with ONLY a JSON array of cell numbers, e.g. [1,4,7]. If none match, reply [].`
    : `This is a reCAPTCHA image challenge. Read the instruction at the top of the image to find the target object.\nNumber the cells left-to-right, top-to-bottom starting at 1.\nReply with ONLY a JSON array of cell numbers, e.g. [1,4,7]. If none match, reply [].`

  log(`OpenAI reCAPTCHA request model=${I94_MODEL}`)
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: I94_MODEL,
      max_completion_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotB64}`, detail: 'high' } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  })
  if (!res.ok) { log('Vision-model reCAPTCHA request failed: ' + res.status); return [] }
  const json = await res.json()
  const raw = json?.choices?.[0]?.message?.content?.trim() ?? '[]'
  try { return JSON.parse(raw.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trim()) } catch { return [] }
}

// ─── reCAPTCHA v2 checkbox + image challenge solver ───────────────────────────

/**
 * Attempts to click the reCAPTCHA v2 "I'm not a robot" checkbox.
 * In a headed browser with reasonable v3 score, this often passes instantly.
 * Returns true if solved, false if not found/failed.
 */
async function solveRecaptchaV2(page, timeoutMs = 15000) {
  log('Looking for reCAPTCHA v2 checkbox...')

  const anchorIframe = page.locator('iframe[src*="recaptcha"][src*="anchor"]').first()
  try {
    await anchorIframe.waitFor({ state: 'visible', timeout: timeoutMs })
  } catch {
    log('No reCAPTCHA anchor iframe visible')
    return false
  }

  const checkboxFrame = page.frameLocator('iframe[src*="recaptcha"][src*="anchor"]').first()

  // Wait for the checkbox element inside the iframe to be ready, then click it
  let clicked = false
  const checkboxEl = checkboxFrame.locator('#recaptcha-anchor, .recaptcha-checkbox-border, .rc-anchor-checkbox, [role="checkbox"]').first()
  try {
    await checkboxEl.waitFor({ state: 'visible', timeout: timeoutMs })
    await checkboxEl.click()
    log('Clicked reCAPTCHA checkbox')
    clicked = true
  } catch (e) {
    log(`Checkbox element wait/click failed: ${e.message.slice(0, 80)} — trying mouse fallback`)
    try {
      const box = await anchorIframe.boundingBox()
      if (box) {
        await page.mouse.click(box.x + 24, box.y + box.height / 2)
        log('Clicked reCAPTCHA checkbox via mouse coordinates')
        clicked = true
      }
    } catch (e2) {
      log('All click attempts failed: ' + e2.message.slice(0, 80))
      return false
    }
  }

  await page.waitForTimeout(2500)

  // Check if already solved (no image challenge needed)
  const solvedQuick = await checkboxFrame.locator('.recaptcha-checkbox-checked, [aria-checked="true"]').count().catch(() => 0)
  if (solvedQuick > 0) {
    log('reCAPTCHA solved instantly (no image challenge)')
    return true
  }

  // Image challenge — up to 6 fresh grids, with dynamic-tile handling inside each
  const challengeFrame = page.frameLocator('iframe[src*="recaptcha"][src*="bframe"]').first()
  const challengeEl    = page.locator('iframe[src*="recaptcha"][src*="bframe"]').first()

  for (let grid = 1; grid <= 6; grid++) {
    log(`reCAPTCHA challenge grid ${grid}...`)

    // Wait up to 20s for grid to appear
    const tableVisible = await challengeFrame
      .locator('.rc-imageselect-table, .rc-imageselect, table')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false)

    if (!tableVisible) {
      const solved = await checkboxFrame.locator('.recaptcha-checkbox-checked, [aria-checked="true"]').count().catch(() => 0)
      if (solved > 0) { log('reCAPTCHA solved!'); return true }
      log('Challenge grid not visible after 20s')
      break
    }

    // Read instruction once per grid
    const instruction = await challengeFrame
      .locator('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical, .rc-imageselect-desc-wrapper')
      .first().innerText().catch(() => '')
    const instrClean = instruction.trim().replace(/\n+/g, ' ')
    if (instrClean) log(`Instruction: "${instrClean}"`)

    // Determine grid size (3×3 = dynamic tiles; 4×4 = static, select-all-then-verify)
    const totalCells = await challengeFrame.locator('.rc-imageselect-tile').count().catch(() => 9)
    const isDynamic = totalCells === 9

    if (isDynamic) {
      // Dynamic 3×3: click tiles → they refresh → keep clicking until none left → verify
      log('Dynamic 3×3 grid — clicking until clear...')
      for (let pass = 1; pass <= 8; pass++) {
        const b64 = (await challengeEl.screenshot()).toString('base64')
        const cells = await askRecaptchaModel(b64, instrClean)
        log(`Pass ${pass} — vision-model cells: ${JSON.stringify(cells)}`)
        if (cells.length === 0) break
        for (const cellNum of cells) {
          const idx = cellNum - 1
          if (idx < 0 || idx >= 9) continue
          try {
            await challengeFrame.locator('.rc-imageselect-tile').nth(idx).click()
            await page.waitForTimeout(600) // wait for tile to refresh
          } catch {}
        }
        await page.waitForTimeout(1000) // settle before next pass
      }
    } else {
      // Static 4×4: select all matching tiles, then verify once
      log(`Static ${totalCells}-tile grid — selecting all then verifying...`)
      const b64 = (await challengeEl.screenshot()).toString('base64')
      const cells = await askRecaptchaModel(b64, instrClean)
      log(`Vision-model cells: ${JSON.stringify(cells)}`)
      for (const cellNum of cells) {
        const idx = cellNum - 1
        if (idx < 0 || idx >= totalCells) continue
        try {
          await challengeFrame.locator('.rc-imageselect-tile').nth(idx).click()
          await page.waitForTimeout(350)
        } catch {}
      }
      await page.waitForTimeout(1000)
    }

    // Click Verify
    try {
      await challengeFrame.locator('#recaptcha-verify-button').click()
      log('Clicked Verify')
    } catch { log('Verify button not found') }
    await page.waitForTimeout(3000)

    // Check if solved
    const solved = await checkboxFrame.locator('.recaptcha-checkbox-checked, [aria-checked="true"]').count().catch(() => 0)
    if (solved > 0) { log('reCAPTCHA solved!'); return true }

    const wrong = await challengeFrame.locator('.rc-imageselect-incorrect-response, .rc-imageselect-error-select-more').isVisible().catch(() => false)
    if (wrong) log('Incorrect selection — next grid...')
  }

  log('reCAPTCHA could not be solved after all grids')
  return false
}

// ─── Core lookup ──────────────────────────────────────────────────────────────

async function fetchI94({ firstName, lastName, birthDate, passportNumber, country }) {
  const dobFormatted = normalizeDob(birthDate)
  const alpha3       = toAlpha3(country)

  log(`Starting lookup: ${firstName} ${lastName} | DOB:${dobFormatted} | Doc:${passportNumber} | Country:${alpha3}`)

  const browser = await chromium.launch({
    channel: 'chrome',  // Use installed Google Chrome — sends real sec-ch-ua, passes more fingerprint checks
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  })

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      },
    })
    await context.addInitScript(() => {
      // Mask automation signals (stealth)
      Object.defineProperty(navigator, 'webdriver', { get: () => false })

      // Make chrome object look real
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} }

      // Realistic plugins list
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ]
          arr.__proto__ = PluginArray.prototype
          return arr
        }
      })

      // Realistic languages
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })

      // Fix permissions
      const originalQuery = window.navigator.permissions?.query
      if (originalQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(params)
      }

      // Hide headless signals
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })

      // Canvas fingerprint noise
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL
      HTMLCanvasElement.prototype.toDataURL = function (type, ...args) {
        const ctx = this.getContext('2d')
        if (ctx) {
          const d = ctx.getImageData(0, 0, this.width, this.height)
          for (let i = 0; i < d.data.length; i += 100) d.data[i] ^= 1
          ctx.putImageData(d, 0, 0)
        }
        return origToDataURL.call(this, type, ...args)
      }
    })
    const page = await context.newPage()

    // Intercept all travel history API responses
    let capturedData = null
    let capturedStatus = null

    page.on('response', async resp => {
      if (!resp.url().includes('/api/services/travel/history')) return
      const status = resp.status()
      log(`Intercepted API response: HTTP ${status}`)
      try {
        const text = await resp.text()
        log('Response body: ' + text.slice(0, 400))
        if (status === 200 && !capturedData) {
          capturedData = JSON.parse(text)
          capturedStatus = 200
        } else if (capturedStatus !== 200) {
          capturedStatus = status
        }
      } catch (e) { log('Could not read response body: ' + e.message) }
    })

    log('Navigating to CBP...')
    await page.goto(`${CBP_URL}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    // Let the page sit for a bit — reCAPTCHA v3 builds a behavioral score over time
    await page.waitForTimeout(5000)

    // 1. Click "View Travel History"
    log('Clicking View Travel History...')
    const viewBtn = page.getByRole('button', { name: /View Travel History/i })
      .or(page.getByRole('link', { name: /View Travel History/i }))
      .first()
    await viewBtn.waitFor({ state: 'visible', timeout: 10000 })
    await viewBtn.click()
    await page.waitForTimeout(1500)

    // 2. Scroll ToS modal and agree
    log('Handling Terms of Service...')
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'))
      const el = all.find(e =>
        e.scrollHeight > e.clientHeight + 2 &&
        /auto|scroll/.test(window.getComputedStyle(e).overflowY) &&
        e !== document.body && e !== document.documentElement
      )
      if (el) el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(800)

    const agreeBtn = page.getByRole('button', { name: /agree|accept|acknowledge/i }).first()
    await agreeBtn.waitFor({ state: 'visible', timeout: 8000 })
    await agreeBtn.click()
    await page.waitForTimeout(1500)

    // 3. Fill form fields
    log('Filling form...')
    await angularFill(page, '#first-name, input[formcontrolname="firstName"]', firstName.trim().toUpperCase())
    await angularFill(page, '#last-name, input[formcontrolname="lastName"]', lastName.trim().toUpperCase())
    await angularFill(page, '#document-number, input[formcontrolname="number"]', passportNumber.trim())

    const dobEl = page.locator('#birth-date, input[formcontrolname="dob"]').first()
    await dobEl.waitFor({ state: 'visible', timeout: 8000 })
    await dobEl.click({ clickCount: 3 })
    await dobEl.fill('')
    await dobEl.pressSequentially(dobFormatted, { delay: 35 })
    await dobEl.press('Tab')
    await page.waitForTimeout(400)

    // 4. Country autocomplete
    log('Filling country...')
    const countryInput = page.locator('input[formcontrolname="alpha3CountryCode"]').first()
    await countryInput.waitFor({ state: 'visible', timeout: 8000 })
    await countryInput.click({ clickCount: 3 })
    await countryInput.pressSequentially(country.trim(), { delay: 50 })
    await page.waitForTimeout(1200)
    const firstOption = page.locator('mat-option, [role="option"]').first()
    try {
      await firstOption.waitFor({ state: 'visible', timeout: 5000 })
      await firstOption.click()
    } catch {
      await countryInput.press('ArrowDown')
      await countryInput.press('Enter')
    }

    // 5. Human-like mouse movements to build reCAPTCHA v3 score, then wait for button to enable
    log('Simulating human behavior and waiting for submit button to enable...')
    await page.waitForTimeout(1000)

    // Random mouse moves across the page
    const vp = page.viewportSize() ?? { width: 1280, height: 900 }
    const moves = [
      [vp.width * 0.3, vp.height * 0.4],
      [vp.width * 0.6, vp.height * 0.5],
      [vp.width * 0.5, vp.height * 0.3],
      [vp.width * 0.4, vp.height * 0.6],
      [vp.width * 0.7, vp.height * 0.4],
      [vp.width * 0.2, vp.height * 0.5],
    ]
    for (const [x, y] of moves) {
      await page.mouse.move(x, y, { steps: 8 })
      await page.waitForTimeout(200 + Math.floor(Math.random() * 300))
    }
    // Scroll down and back up slowly
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(400)
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(600)

    // Wait up to 15s for the submit button to become enabled
    const submitBtn = page.locator('#submit-travel-history').first()
    let btnEnabled = false
    for (let i = 0; i < 15; i++) {
      const disabled = await submitBtn.getAttribute('disabled').catch(() => 'true')
      if (disabled === null) { btnEnabled = true; break }
      await page.waitForTimeout(1000)
    }
    log(`Submit button enabled: ${btnEnabled}`)

    // 6. Click submit
    log('Submitting form...')
    try {
      if (btnEnabled) {
        await submitBtn.click()
      } else {
        // Try clicking anyway (force) in case attribute check was wrong
        await submitBtn.click({ force: true })
      }
    } catch {
      await page.keyboard.press('Enter')
    }
    await page.waitForTimeout(4000)

    // 7. If 403, start reCAPTCHA v2 solve, then poll for verified + re-submit
    if (capturedStatus === 403) {
      log('Got 403 — solving reCAPTCHA v2 image challenge...')
      await page.waitForTimeout(2000)
      await solveRecaptchaV2(page, 15000) // best-effort — user can also solve manually

      // After solver finishes (or user helps), poll for verified checkbox then re-submit
      log('Polling for reCAPTCHA verification...')
      const checkboxFrame2 = page.frameLocator('iframe[src*="recaptcha"][src*="anchor"]').first()
      const verifyDeadline = Date.now() + 120000 // wait up to 2min for user/solver to verify
      let resubmitted = false
      while (!capturedData && Date.now() < verifyDeadline) {
        const verified = await checkboxFrame2
          .locator('.recaptcha-checkbox-checked, [aria-checked="true"]')
          .count().catch(() => 0)
        if (verified > 0 && !resubmitted) {
          log('reCAPTCHA verified — clicking Continue...')
          capturedStatus = null
          capturedData = null
          try { await submitBtn.click() } catch { await page.keyboard.press('Enter') }
          resubmitted = true
          await page.waitForTimeout(4000)
        }
        await page.waitForTimeout(800)
      }
    }

    // 8. Wait for a 200 API response (up to 30s after reCAPTCHA flow)
    log('Waiting for results...')
    const deadline2 = Date.now() + 30000
    while (!capturedData && Date.now() < deadline2) {
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(1000)

    // Save screenshot for debugging
    try {
      const { writeFileSync } = await import('fs')
      const shot = await page.screenshot({ fullPage: true })
      writeFileSync('/tmp/i94-debug.png', shot)
      log('Screenshot saved to /tmp/i94-debug.png')
    } catch {}

    // 9. Parse result
    if (capturedStatus === 403) {
      log('CBP returned 403 — reCAPTCHA score too low')
    }
    if (capturedData) {
      return parseApiResponse(capturedData)
    }

    // Fallback: try to read from the page DOM
    log('API response not captured, trying DOM extraction...')
    return await extractFromDom(page)

  } finally {
    await browser.close()
  }
}

// ─── Parse CBP API response ───────────────────────────────────────────────────

function parseApiResponse(data) {
  log('Parsing API response keys: ' + Object.keys(data ?? {}).join(', '))

  const rows =
    data?.travelHistory ??
    data?.history ??
    data?.records ??
    data?.data ??
    (Array.isArray(data) ? data : null) ??
    []

  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, history: [], raw: data }
  }

  if (rows[0]) log('First row sample: ' + JSON.stringify(rows[0]))

  const history = rows.map(row => ({
    date:     String(row.date ?? row.arrivalDate ?? row.eventDate ?? '').trim(),
    type:     String(row.type ?? row.i94Class ?? row.eventType ?? row.admitClass ?? '').trim(),
    location: String(row.location ?? row.portCode ?? row.port ?? row.portOfEntry ?? '').trim(),
  })).filter(r => r.date)

  return { success: history.length > 0, history }
}

// ─── DOM fallback extraction ──────────────────────────────────────────────────

async function extractFromDom(page) {
  try {
    const rows = await page.$$eval('table tbody tr, mat-row', els =>
      els.map(el => {
        const cells = Array.from(el.querySelectorAll('td, mat-cell')).map(c => c.textContent?.trim() ?? '')
        return cells.filter(Boolean)
      }).filter(cells => cells.length >= 2)
    )
    if (rows.length > 0) {
      log(`DOM extracted ${rows.length} rows`)
      const history = rows.map(cells => ({
        date: cells[0] ?? '',
        type: cells[1] ?? '',
        location: cells[2] ?? '',
      }))
      return { success: true, history }
    }
  } catch (e) {
    log('DOM extraction failed: ' + e.message)
  }
  return { success: false, history: [] }
}

// ─── POST /lookup ─────────────────────────────────────────────────────────────

app.post('/lookup', async (req, res) => {
  const { firstName, lastName, birthDate, passportNumber, country } = req.body ?? {}
  if (!firstName || !lastName || !birthDate || !passportNumber || !country) {
    return res.status(400).json({ error: 'Missing required fields: firstName, lastName, birthDate, passportNumber, country' })
  }

  const start = Date.now()
  try {
    const result = await fetchI94({ firstName, lastName, birthDate, passportNumber, country })
    log(`Lookup complete in ${((Date.now()-start)/1000).toFixed(1)}s — success=${result.success} entries=${result.history?.length}`)
    res.json(result)
  } catch (e) {
    log('Lookup error: ' + e.message)
    res.status(500).json({ error: e.message ?? 'Lookup failed' })
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[i94-service] Listening on port ${PORT}`)
  console.log(`[i94-service] Secret: ${SECRET ? 'configured' : 'NONE (open access!)'}`)
})
