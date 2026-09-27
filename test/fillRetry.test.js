import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  classifyRecoveryInput,
  closeCeacFillTabs,
  extractApplicationId,
  fillCaptchaAnswer,
  fillRecoveryApplicationId,
  fillRecoverySecurityByEditableOrder,
  retrieveSecurityReady,
  isApplicationAlreadySubmittedError,
  isAlreadySubmittedRetrieveDialog,
  isCeacFillTabUrl,
  isClosedBrowserError,
  isStallError,
  isStuckSessionError,
  MAX_FILL_ATTEMPTS,
  MAX_RETRIEVE_FAILURES_BEFORE_FRESH,
  firstFiveSurnameLetters,
  nextAttemptMode,
  parseApplicationId,
  recoveryPageKind,
  shouldReloadCeacLanding,
  shouldRetryFillAfterError,
  waitForApplicationId,
} from '../autofill/fill-ds160.js'
import {
  CEAC_SERVICE_UNAVAILABLE_PREFIX,
  isCeacServiceUnavailableError,
  isCeacServiceUnavailableSignals,
  isFatalCloudflareError,
} from '../autofill/agent.js'

test('retrieve surname prefix is the first 5 characters, including a space', () => {
  assert.equal(firstFiveSurnameLetters('BEN TADMOR'), 'BEN T')
  assert.equal(firstFiveSurnameLetters('ben tal'), 'BEN T')
  assert.equal(firstFiveSurnameLetters("O'BRIEN"), "O'BRI")
  assert.equal(firstFiveSurnameLetters('DAAS'), 'DAAS')
  assert.equal(firstFiveSurnameLetters('BITON'), 'BITON')
  assert.equal(firstFiveSurnameLetters('KOFMAN TOBUL'), 'KOFMA')
})

test('parseApplicationId accepts 10-character CEAC IDs', () => {
  assert.equal(parseApplicationId('aa00fni7c7'), 'AA00FNI7C7')
  assert.equal(parseApplicationId(' AA00FQCBAB '), 'AA00FQCBAB')
  assert.equal(parseApplicationId('short'), '')
  assert.equal(parseApplicationId('AA00TOO-LONG'), '')
})

test('CEAC landing is not reloaded when the security-check page is already showing', () => {
  assert.equal(shouldReloadCeacLanding('https://ceac.state.gov/GenNIV/Default.aspx'), false)
  assert.equal(shouldReloadCeacLanding('about:blank'), true)
  assert.equal(shouldReloadCeacLanding('https://ceac.state.gov/GenNIV/Default.aspx?node=Personal1'), false)
  assert.equal(
    shouldReloadCeacLanding(
      'https://identix.state.gov/qotw/Default.aspx?QP=%2b%2fKTtC10vRiqyWMedH%2fOTZM%2bGkEvtIIOAzZlq4VTlKkuPrFyfoR%2bHloIP%2bKraz',
    ),
    true,
  )
})

test('identix HTTP 503 is a retrieve retry, not a fatal close', () => {
  const identix503 = {
    title: 'Service Unavailable',
    html: 'HTTP Error 503. The service is unavailable.',
    url: 'https://identix.state.gov/qotw/Default.aspx',
  }
  assert.equal(isCeacServiceUnavailableSignals(identix503), true)
  assert.equal(isCeacServiceUnavailableSignals({
    title: 'Personal Information 1',
    html: 'Application ID AA00FSV6QB',
    url: 'https://ceac.state.gov/GenNIV/General/complete/complete_personal.aspx?node=Personal1',
  }), false)

  const err = new Error(`${CEAC_SERVICE_UNAVAILABLE_PREFIX}: identix/CEAC returned HTTP 503`)
  assert.equal(isCeacServiceUnavailableError(err), true)
  assert.equal(shouldRetryFillAfterError(err, { hasAppId: true }), true)
  assert.equal(shouldRetryFillAfterError(err, { hasAppId: false }), true)
  assert.equal(isClosedBrowserError(new Error('⚠️  PAGE CLOSED (browser window was closed or tab crashed)')), false)
  assert.equal(isClosedBrowserError(new Error('page has been closed')), true)
  assert.equal(shouldRetryFillAfterError(new Error('page has been closed'), { hasAppId: true }), true)
  assert.equal(shouldRetryFillAfterError(new Error('page has been closed'), { hasAppId: false }), false)
  assert.equal(shouldRetryFillAfterError(new Error('page has been closed'), { hasAppId: true, abort: true }), false)
  assert.equal(shouldRetryFillAfterError(new Error('CLOUDFLARE_HEADLESS: blocked'), { hasAppId: true }), false)
  assert.equal(isFatalCloudflareError(new Error('CLOUDFLARE_HEADLESS: blocked')), true)
  const stall = new Error(
    '⛔ Stall detected — stuck on page "travel" for 61 consecutive steps (limit: 60). Aborting.',
  )
  assert.equal(isStallError(stall), true)
  assert.equal(isStuckSessionError(stall), true)
  assert.equal(shouldRetryFillAfterError(stall, { hasAppId: true }), true)
  assert.equal(shouldRetryFillAfterError(stall, { hasAppId: false }), true)
  const already = new Error(
    'APPLICATION_ALREADY_SUBMITTED: The DS-160 application you are attempting to retrieve has been submitted.',
  )
  assert.equal(isAlreadySubmittedRetrieveDialog(
    'The DS-160 application you are attempting to retrieve has been submitted. Select an option below and click the "Continue" button.',
  ), true)
  assert.equal(isApplicationAlreadySubmittedError(already), true)
  assert.equal(shouldRetryFillAfterError(already, { hasAppId: true }), false)
  assert.equal(shouldRetryFillAfterError(already, { hasAppId: false }), false)
})

test('only CEAC fill tabs are treated as closable at the end of a run', () => {
  assert.equal(isCeacFillTabUrl('https://ceac.state.gov/GenNIV/Default.aspx'), true)
  assert.equal(isCeacFillTabUrl('https://ceac.state.gov/GenNIV/General/complete/complete.aspx'), true)
  assert.equal(isCeacFillTabUrl('https://mail.google.com/'), false)
  assert.equal(isCeacFillTabUrl('about:blank'), false)
})

test('closeCeacFillTabs closes CEAC tabs and leaves other tabs open', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const keep = await context.newPage()
    await keep.goto('about:blank')
    const fill = await context.newPage()
    await fill.route('https://ceac.state.gov/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>CEAC</body></html>',
    }))
    await fill.goto('https://ceac.state.gov/GenNIV/Default.aspx')
    assert.equal(await closeCeacFillTabs(context), 1)
    assert.equal(fill.isClosed(), true)
    assert.equal(keep.isClosed(), false)
  } finally {
    await browser.close()
  }
})

test('nextAttemptMode retrieves only after Personal Information 1 is saved', () => {
  assert.equal(MAX_FILL_ATTEMPTS, 3)
  assert.equal(nextAttemptMode(1, { startWithRetrieve: false, appId: '' }), 'setup')
  assert.equal(nextAttemptMode(1, { startWithRetrieve: true, appId: 'AA00FNI7C7', personal1Saved: true }), 'retrieve')
  assert.equal(nextAttemptMode(1, { startWithRetrieve: true, appId: 'AA00FNI7C7', personal1Saved: false }), 'setup')
  assert.equal(nextAttemptMode(2, { startWithRetrieve: false, appId: 'AA00FNI7C7', personal1Saved: true }), 'retrieve')
  assert.equal(nextAttemptMode(2, { startWithRetrieve: false, appId: 'AA00FNI7C7' }), 'setup')
  assert.equal(nextAttemptMode(2, { startWithRetrieve: false, appId: '' }), 'setup')
  assert.equal(MAX_RETRIEVE_FAILURES_BEFORE_FRESH, 2)
  const retrieving = { startWithRetrieve: true, appId: 'AA00FNI7C7', personal1Saved: true }
  assert.equal(nextAttemptMode(2, { ...retrieving, retrieveFailures: 1 }), 'retrieve')
  assert.equal(nextAttemptMode(3, { ...retrieving, retrieveFailures: 2 }), 'setup')
})

test('extractApplicationId reads the CEAC banner from a personal1 snapshot', async () => {
  const html = readFileSync('dom-snapshots/personal1.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    assert.equal(await extractApplicationId(page), 'AA00FNI7C7')
  } finally {
    await browser.close()
  }
})

test('waitForApplicationId sees the banner as soon as Personal 1 is shown', async () => {
  const html = readFileSync('dom-snapshots/personal1.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    assert.equal(await waitForApplicationId(page, { timeoutMs: 1000 }), 'AA00FNI7C7')
  } finally {
    await browser.close()
  }
})

test('classifyRecoveryInput never treats Application ID as surname', () => {
  assert.equal(
    classifyRecoveryInput({
      id: 'ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxApplicationID',
      name: 'ctl00$SiteContentPlaceHolder$ApplicationRecovery1$tbxApplicationID',
      maxLength: 10,
    }),
    'application_id',
  )
  assert.equal(classifyRecoveryInput({ id: 'tbxSurname', name: '' }), 'surname')
  assert.equal(
    classifyRecoveryInput({ id: 'ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha' }),
    'captcha',
  )
  assert.equal(classifyRecoveryInput({ id: 'tbxYearOfBirth', maxLength: 4 }), 'year')
  assert.equal(classifyRecoveryInput({ id: 'txtAnswer', name: 'SecurityAnswer' }), 'answer')
})

const RECOVERY_APP_ID_HTML = `
  <p>You will need: Application ID, First 5 letters of Surname, Year of Birth, and Security Questions.</p>
  <table>
    <tr>
      <td>Your Application ID</td>
      <td>
        <input id="ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxApplicationID"
               name="ctl00$SiteContentPlaceHolder$ApplicationRecovery1$tbxApplicationID"
               type="text" maxlength="10" value="">
      </td>
    </tr>
  </table>
`

const RECOVERY_SURNAME_YEAR_HTML = `
  <table>
    <tr>
      <td>First 5 letters of Surname</td>
      <td><input id="ctl00_SiteContentPlaceHolder_ApplicationRecovery1_txbSurname" type="text" maxlength="5"></td>
    </tr>
    <tr>
      <td>Year of Birth</td>
      <td><input id="ctl00_SiteContentPlaceHolder_ApplicationRecovery1_txbDOBYear" type="text" maxlength="4"></td>
    </tr>
  </table>
`

test('retrieve page with only surname and year does not require a security answer', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(RECOVERY_SURNAME_YEAR_HTML, { waitUntil: 'domcontentloaded' })
    const ordered = await fillRecoverySecurityByEditableOrder(page, {
      surname5: 'DAAS',
      birthYear: '1988',
      securityAnswer: '049824393',
    })
    assert.equal(ordered.filledSurname, true)
    assert.equal(ordered.filledYear, true)
    assert.equal(ordered.filledAnswer, false)
    assert.equal(ordered.answerOnPage, false)
    assert.equal(retrieveSecurityReady(ordered), true)
    assert.equal(
      await page.locator('#ctl00_SiteContentPlaceHolder_ApplicationRecovery1_txbSurname').inputValue(),
      'DAAS',
    )
    assert.equal(
      await page.locator('#ctl00_SiteContentPlaceHolder_ApplicationRecovery1_txbDOBYear').inputValue(),
      '1988',
    )
  } finally {
    await browser.close()
  }
})

const RECOVERY_CAPTCHA_HTML = `
  <h1>Retrieve a DS-160 Application</h1>
  <div style="color:red">Enter the code as shown is required.</div>
  <table>
    <tr>
      <td>Your Application ID is:</td>
      <td>
        <input id="ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxApplicationID"
               type="text" value="AA00FT062P">
      </td>
    </tr>
    <tr>
      <td colspan="2">
        <span>Enter the code as shown:</span>
        <input id="ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxBarcode" type="text" maxlength="8">
        <img class="LBD_CaptchaImage" alt="CAPTCHA" src="/GenNIV/BotDetectCaptcha.ashx?get=image">
      </td>
    </tr>
  </table>
  <input type="submit" value="Retrieve Application">
`

test('retrieve captcha code goes in the image box, not the Application ID', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(RECOVERY_CAPTCHA_HTML, { waitUntil: 'domcontentloaded' })
    assert.equal(await fillCaptchaAnswer(page, 'B8TPP'), true)
    assert.equal(
      await page.locator('#ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxBarcode').inputValue(),
      'B8TPP',
    )
    assert.equal(
      await page.locator('#ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxApplicationID').inputValue(),
      'AA00FT062P',
    )
  } finally {
    await browser.close()
  }
})

test('retrieve Application ID page is not treated as the surname/security step', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(RECOVERY_APP_ID_HTML, { waitUntil: 'domcontentloaded' })
    assert.equal(await recoveryPageKind(page), 'application_id')

    const ordered = await fillRecoverySecurityByEditableOrder(page, {
      surname5: 'BITON',
      birthYear: '1972',
      securityAnswer: '049824393',
    })
    assert.equal(ordered.filledSurname, false)
    assert.equal(ordered.filledYear, false)
    assert.equal(ordered.filledAnswer, false)
    assert.equal(
      await page.locator('#ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxApplicationID').inputValue(),
      '',
    )

    assert.equal(await fillRecoveryApplicationId(page, 'AA00FSTKJV'), true)
    assert.equal(
      await page.locator('#ctl00_SiteContentPlaceHolder_ApplicationRecovery1_tbxApplicationID').inputValue(),
      'AA00FSTKJV',
    )
  } finally {
    await browser.close()
  }
})
