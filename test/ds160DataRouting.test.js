import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  applyMilitarySpecializedSkillsToAnswerSheet,
  applyMilitarySpecializedSkillsToTranslatedText,
  normalizeDs160SourceData,
} from '../api/translate-form.js'
import {
  actionCanBeDeferredForTesting,
  detectCurrentPageContext,
  clickStartApplication,
  disarmCeacUnload,
  executeAction,
  filterTranslatedText,
  isBlockedSubmissionClick,
  missingSignSubmitFields,
  isCloudflareChallengeSignals,
  isCloudflareHardBlockSignals,
  isFatalCloudflareError,
  capPrevUsVisits,
  parseCountriesVisitedFromSource,
  parseLanguagesFromSource,
  parseEducationCitiesFromSource,
  parsePreviousEmployerCitiesFromSource,
  parsePackedUsAddress,
  parsePrevTravelFromSource,
  parseIntendedStayFromSource,
  parseSocialMediaFromSource,
  parseTravelCompanions,
  parsePayerCompanyFromSource,
  parseUsStayAddressFromSource,
  socialMediaIdentifier,
  syncPayerCompanyFromSource,
  syncPrevTravelFromSource,
  syncIntendedStayFromSource,
  syncSocialMediaFromSource,
  syncSpouseNameFromSource,
  syncTravelCompanionsFromSource,
  syncUsStayAddressFromSource,
} from '../autofill/agent.js'
import { diffInventory, extractPageInventory, findUnplannedRequired } from '../autofill/page-inventory.js'
import { parseApplicantSource } from '../autofill/parse-applicant-source.js'

test('Cloudflare Turnstile interstitial is detected from page signals', () => {
  assert.equal(
    isCloudflareChallengeSignals({
      title: 'Just a moment...',
      html: '<div>Performing security verification. Verify you are human.</div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
      url: 'https://ceac.state.gov/GenNIV/Default.aspx',
    }),
    true,
  )
  assert.equal(
    isCloudflareChallengeSignals({
      title: 'Just a moment...',
      html: '<html></html>',
      url: 'https://ceac.state.gov/GenNIV/Default.aspx?__cf_chl_rt_tk=abc',
    }),
    true,
  )
  assert.equal(
    isCloudflareChallengeSignals({
      title: 'Nonimmigrant Visa - Instructions',
      html: '<img id="CaptchaImage" src="/captcha"><input id="txtcaptcha">',
      url: 'https://ceac.state.gov/GenNIV/Default.aspx',
    }),
    false,
  )
  assert.equal(
    isCloudflareChallengeSignals({
      title: 'Just a moment...',
      html: `
        <select id="ctl00_SiteContentPlaceHolder_ucLocationSearch_ddlLocation"></select>
        <img id="CaptchaImage" src="/captcha">
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
      `,
      url: 'https://ceac.state.gov/GenNIV/Default.aspx',
    }),
    false,
    'stale Just a moment title on the real CEAC landing is not an interstitial',
  )
  assert.equal(
    isCloudflareChallengeSignals({
      title: 'Nonimmigrant Visa - Present Work/Education/Training Information',
      html: `
        <div>Consular Electronic Application Center</div>
        <span>Application ID AA00FSR0F9</span>
        <div id="ctl00_SiteContentPlaceHolder">Primary Occupation</div>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
        <div class="cf-turnstile"></div>
      `,
      url: 'https://ceac.state.gov/GenNIV/General/complete/complete_workeducation1.aspx?node=WorkEducation1',
    }),
    false,
    'background Turnstile JS on a real CEAC form page is not an interstitial',
  )
})

test('Cloudflare hard-block page is distinct from a Turnstile challenge', () => {
  assert.equal(
    isCloudflareHardBlockSignals({
      title: 'Attention Required! | Cloudflare',
      html: '<h1>Sorry, you have been blocked</h1><p>You are unable to access ceac.state.gov</p>',
      url: 'https://ceac.state.gov/GenNIV/Default.aspx',
    }),
    true,
  )
  assert.equal(
    isCloudflareHardBlockSignals({
      title: 'Just a moment...',
      html: 'Performing security verification',
      url: 'https://ceac.state.gov/GenNIV/Default.aspx',
    }),
    false,
  )
  assert.equal(
    isFatalCloudflareError(new Error('CLOUDFLARE_HARD_BLOCK: banned')),
    false,
  )
  assert.equal(
    isFatalCloudflareError(new Error('CLOUDFLARE_HEADLESS: cannot complete')),
    true,
  )
  assert.equal(
    isFatalCloudflareError(new Error('Could not find embassy dropdown')),
    false,
  )
})

test('required repeat rows cannot be silently deferred', () => {
  assert.equal(
    actionCanBeDeferredForTesting({ type: 'click', text: 'Add Another Travel Companion' }),
    false,
  )
  assert.equal(
    actionCanBeDeferredForTesting({ type: 'click', text: 'Add Another' }),
    false,
  )
  assert.equal(
    actionCanBeDeferredForTesting({ type: 'fill', label: 'Optional note', optional: true }),
    true,
  )
})

test('submission guard allows navigation but blocks direct final submission', () => {
  assert.equal(
    isBlockedSubmissionClick({ type: 'click', text: 'Next: Sign and Submit' }),
    false,
  )
  assert.equal(
    isBlockedSubmissionClick({ type: 'click', text: 'Sign and Submit Application' }),
    true,
  )
})

test('sign/submit gate names each missing field', () => {
  assert.deepEqual(
    missingSignSubmitFields({}),
    ['assistance Yes', 'organization', 'relationship', 'passport number', 'CAPTCHA'],
  )
  assert.deepEqual(
    missingSignSubmitFields({
      jvisaAssistance: true,
      organization: 'JVISA',
      relationship: 'SELECT ONE',
      passport: '37282221',
      captcha: '',
    }),
    ['relationship', 'CAPTCHA'],
  )
  assert.deepEqual(
    missingSignSubmitFields({
      jvisaAssistance: true,
      organization: 'JVISA',
      relationship: 'CLERK',
      passport: '37282221',
      captcha: '619335',
    }),
    [],
  )
})

test('submitApplication names missing Sign page fields', async () => {
  const html = readFileSync('dom-snapshots/submit--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      () => executeAction(page, { type: 'submitApplication' }),
      /still missing assistance Yes, organization, relationship, passport number, CAPTCHA/,
    )
  } finally {
    await browser.close()
  }
})

test('Israeli national ID is never treated as a passport book number', () => {
  const normalized = normalizeDs160SourceData({
    nationality: 'Israel',
    passportIssuingCountry: 'Israel',
    passportBookNumber: '0-3854015-9',
    passportBookNumberDoesNotApply: false,
  })

  assert.equal(normalized.passportBookNumber, '')
  assert.equal(normalized.passportBookNumberDoesNotApply, true)
})

test('non-Israeli passport book number remains unchanged', () => {
  const normalized = normalizeDs160SourceData({
    nationality: 'United States',
    passportIssuingCountry: 'United States',
    passportBookNumber: '123456789',
    passportBookNumberDoesNotApply: false,
  })

  assert.equal(normalized.passportBookNumber, '123456789')
  assert.equal(normalized.passportBookNumberDoesNotApply, false)
})

test('organization without a contact person becomes name Do Not Know', () => {
  const normalized = normalizeDs160SourceData({
    contactOrganization: 'HOTELS',
    contactSurnames: '',
    contactGivenNames: '',
    contactNameDoNotKnow: false,
  })

  assert.equal(normalized.contactNameDoNotKnow, true)
  assert.equal(normalized.contactSurnames, '')
  assert.equal(normalized.contactGivenNames, '')
  assert.equal(normalized.contactOrganization, 'HOTELS')
})

test('IDF / military service implies specialized skills firearms training', () => {
  const served = normalizeDs160SourceData({
    servedInMilitary: 'yes',
    militaryService: [{ country: 'Israel', branch: 'General Corps', rank: 'Staff Sergeant' }],
    hasSpecializedSkills: 'no',
    specializedSkillsDescription: '',
  })
  assert.equal(served.hasSpecializedSkills, 'yes')
  assert.equal(served.specializedSkillsDescription, 'FIREARMS MILITARY TRAINING')

  const civilian = normalizeDs160SourceData({
    servedInMilitary: 'no',
    hasSpecializedSkills: 'no',
  })
  assert.equal(civilian.hasSpecializedSkills, 'no')

  const custom = normalizeDs160SourceData({
    servedInMilitary: 'yes',
    specializedSkillsDescription: 'Explosives demolition course',
  })
  assert.equal(custom.specializedSkillsDescription, 'Explosives demolition course')

  const rewritten = applyMilitarySpecializedSkillsToTranslatedText([
    'Do you possess specialized skills or training involving firearms, explosives, nuclear, biological, or chemical experience? No',
    'Have you served in the military? Yes',
  ].join('\n'))
  assert.match(rewritten, /experience\? Yes/)
  assert.match(rewritten, /Full Description: FIREARMS MILITARY TRAINING/)

  const sheet = applyMilitarySpecializedSkillsToAnswerSheet({
    work_additional: { military_service: true, specialized_skills_or_training: false },
  })
  assert.equal(sheet.work_additional.specialized_skills_or_training, true)
  assert.equal(sheet.work_additional.specialized_skills_explanation, 'FIREARMS MILITARY TRAINING')

  const fromSavedFile = parseApplicantSource(readFileSync('people/nira.txt', 'utf8'))
  assert.match(fromSavedFile.text, /specialized skills or training involving firearms[^\n]*\? Yes/)
  assert.match(fromSavedFile.text, /Full Description: FIREARMS MILITARY TRAINING/)
  assert.equal(fromSavedFile.answerSheet.work_additional.specialized_skills_or_training, true)
  assert.equal(fromSavedFile.answerSheet.work_additional.specialized_skills_explanation, 'FIREARMS MILITARY TRAINING')
})

test('contact person without an organization becomes organization Do Not Know', () => {
  const normalized = normalizeDs160SourceData({
    contactSurnames: 'Mishel',
    contactGivenNames: 'Orpaz',
    contactOrganization: '',
    contactOrganizationDoNotKnow: false,
  })

  assert.equal(normalized.contactOrganizationDoNotKnow, true)
  assert.equal(normalized.contactOrganization, '')
  assert.equal(normalized.contactSurnames, 'Mishel')
})

test('employer names in source JSON drop the Ltd. period', () => {
  const normalized = normalizeDs160SourceData({
    previousEmployments: [{ employerName: 'Elbit Systems Ltd.', jobTitle: 'Facilities Operator' }],
  })
  assert.equal(normalized.previousEmployments[0].employerName, 'Elbit Systems Ltd')
})

test('previous U.S. travel page is detected from node=PreviousTravel', async () => {
  const page = {
    url: () =>
      'https://ceac.state.gov/GenNIV/General/complete/complete.aspx?node=PreviousTravel',
  }
  assert.equal(await detectCurrentPageContext(page), 'prev_travel')
})

test('previous U.S. travel page is detected from PreviousUSTravel URLs', async () => {
  const byNode = {
    url: () =>
      'https://ceac.state.gov/GenNIV/General/complete/complete.aspx?node=PreviousUSTravel',
  }
  const byPath = {
    url: () =>
      'https://ceac.state.gov/GenNIV/General/complete/complete_previousustravel.aspx',
  }
  assert.equal(await detectCurrentPageContext(byNode), 'prev_travel')
  assert.equal(await detectCurrentPageContext(byPath), 'prev_travel')
})

test('listed previous visits imply Yes even if the gating question is missing', () => {
  const parsed = parsePrevTravelFromSource([
    'Arrival Date: 19/01/2019',
    'Length of Stay: 21 days',
    'Visa Number: L9066286',
  ].join('\n'))
  assert.equal(parsed.beenInUs, true)
  assert.equal(parsed.issuedVisa, true)
  assert.equal(parsed.beenInUsAnswer, null)
})

test('packed stay street keeps only the street when city, state, and ZIP are on their own lines', () => {
  const parsed = parseUsStayAddressFromSource([
    'Street Address (Line 1): 1217 Bay Park Pl Far Rockaway, NY 11691 United States',
    'City: Far Rockaway',
    'State: NY',
    'ZIP Code: 11691',
  ].join('\n'))
  assert.deepEqual(parsed, {
    street: '1217 Bay Park Pl',
    city: 'Far Rockaway',
    state: 'NY',
    zip: '11691',
  })
})

test('U.S. stay address is parsed from the travel section', () => {
  const parsed = parseUsStayAddressFromSource([
    '🟦 TRAVEL INFORMATION',
    'Street Address (Line 1): 2508 Cardamon Avenue',
    'City: Cooper City',
    'State: FL',
    'ZIP Code: 33026',
  ].join('\n'))
  assert.deepEqual(parsed, {
    street: '2508 Cardamon Avenue',
    city: 'Cooper City',
    state: 'FL',
    zip: '33026',
  })
})

test('U.S. stay address does not reuse the payer company address in Israel', () => {
  const parsed = parseUsStayAddressFromSource([
    '🟦 TRAVEL INFORMATION',
    'Arrival City: New York',
    'Provide the locations you plan to visit in the U.S.: Washington DC',
    '**PERSON/ENTITY PAYING FOR TRIP**',
    'Who is paying for the trip? Other Company/Organization',
    'Street Address (Line 1): Kanfei Nesharim 5',
    'City: Jerusalem',
    'State/Province: DOES NOT APPLY',
    'Postal Zone/ZIP Code: 9546412',
    'Country/Region: Israel',
    '🟦 U.S. CONTACT INFORMATION',
    'Organization Name: HOTELS',
    '**U.S. ADDRESS**',
    'Street Address: HOTELS',
    'City: New York',
    'State: NY',
    'ZIP Code: DOES NOT APPLY',
    '**CONTACT DETAILS**',
    'Phone Number: 0000000000',
  ].join('\n'))
  assert.deepEqual(parsed, {
    street: 'HOTELS',
    city: 'New York',
    state: 'NY',
    zip: '00000',
  })
})

test('a real U.S. stay address wins over the payer address and the U.S. contact', () => {
  const parsed = parseUsStayAddressFromSource([
    '🟦 TRAVEL INFORMATION',
    'Address Where You Will Stay in the U.S.:',
    'Street Address (Line 1): Hotels',
    'City: New York',
    'State: NY',
    'ZIP Code: N/A',
    'PERSON/ENTITY PAYING FOR TRIP',
    'Street Address (Line 1): Kanfei Nesharim 5',
    'City: Jerusalem',
    'Postal Zone/ZIP Code: 9546412',
    '🟦 U.S. CONTACT INFORMATION',
    '**U.S. ADDRESS**',
    'Street Address: 1 Other Street',
    'City: Boston',
    'State: MA',
    'ZIP Code: 02101',
  ].join('\n'))
  assert.deepEqual(parsed, {
    street: 'Hotels',
    city: 'New York',
    state: 'NY',
    zip: '00000',
  })
})

test('U.S. stay keeps Hotels on the street line and city New York when ZIP is N/A', () => {
  const parsed = parseUsStayAddressFromSource([
    '🟦 TRAVEL INFORMATION',
    'Street Address (Line 1): Hotels',
    'Street Address (Line 2): N/A',
    'City: New York',
    'State: NY',
    'ZIP Code: N/A',
  ].join('\n'))
  assert.deepEqual(parsed, {
    street: 'Hotels',
    city: 'New York',
    state: 'NY',
    zip: '00000',
  })

  const fromSavedFile = parseApplicantSource(readFileSync('people/nira.txt', 'utf8'))
  assert.match(fromSavedFile.text, /Street Address \(Line 1\): Hotels/)
  assert.match(fromSavedFile.text, /City: New York/)
  assert.match(fromSavedFile.text, /ZIP Code: 00000/)
  assert.equal(fromSavedFile.answerSheet.travel.us_stay_address.street_address_line1, 'Hotels')
  assert.equal(fromSavedFile.answerSheet.travel.us_stay_address.city, 'New York')
  assert.equal(fromSavedFile.answerSheet.travel.us_stay_address.zip_code, '00000')
})

test('spouse page receives only spouse source data', async () => {
  const page = {
    url: () =>
      'https://ceac.state.gov/GenNIV/General/complete/complete_family2.aspx?node=Spouse',
  }
  const translatedText = [
    '🟦 FAMILY INFORMATION',
    'Relative Surname: MANOVA COHEN',
    'Relative Given Name: Eden',
    '',
    '🟦 SPOUSE INFORMATION',
    'Spouse Surname: COHEN',
    'Spouse Given Name: Natalie',
    'Spouse Date of Birth: 19/03/1978',
    '',
    '🟦 PREVIOUS SPOUSES',
    'Have you ever been married before? No',
  ].join('\n')

  const context = await detectCurrentPageContext(page)
  const spouseSection = filterTranslatedText(translatedText, context)

  assert.equal(context, 'spouse')
  assert.match(spouseSection, /Spouse Given Name: Natalie/)
  assert.doesNotMatch(spouseSection, /Eden|Relative Surname/)
})

test('all travel companions are parsed in source order', () => {
  const companions = parseTravelCompanions([
    '🟦 TRAVEL COMPANIONS',
    'Surnames of Person Traveling With You: COHEN',
    'Given Names of Person Traveling With You: Natalie',
    'Relationship: Spouse',
    'Surnames of Person Traveling With You: COHEN',
    'Given Names of Person Traveling With You: Shira',
    'Relationship: Child',
  ].join('\n'))

  assert.deepEqual(companions, [
    { surname: 'COHEN', givenName: 'Natalie', relationship: 'Spouse' },
    { surname: 'COHEN', givenName: 'Shira', relationship: 'Child' },
  ])
})

// ─── Page Inventory tests ─────────────────────────────────────────────────────

test('inventory: personal1 snapshot finds Surnames, Given Names, Sex, Date of Birth', async () => {
  const html = readFileSync('dom-snapshots/personal1--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inv = await extractPageInventory(page)

    const labels = inv.fields.map((f) => f.label)
    assert.ok(labels.some((l) => /surname/i.test(l)), 'Should find Surnames field')
    assert.ok(labels.some((l) => /given name/i.test(l)), 'Should find Given Names field')
    assert.ok(labels.some((l) => /sex/i.test(l)), 'Should find Sex field')
    assert.ok(labels.some((l) => /date/i.test(l)), 'Should find a date field')

    // Confirm kinds are reasonable
    const sexField = inv.fields.find((f) => /sex/i.test(f.label))
    assert.ok(['select', 'select-large', 'radio'].includes(sexField?.kind), 'Sex should be select or radio')
  } finally {
    await browser.close()
  }
})

test('inventory: radio groups collapse to one entry per rbl group', async () => {
  const html = readFileSync('dom-snapshots/personal1--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inv = await extractPageInventory(page)

    const radios = inv.fields.filter((f) => f.kind === 'radio')
    // Should NOT have individual _0 or _1 refs — groups only
    for (const f of radios) {
      assert.ok(!f.ref.endsWith('_0') && !f.ref.endsWith('_1'), `Radio ref should be group: ${f.ref}`)
      assert.deepEqual(f.options, ['Yes', 'No'], `Radio options should be [Yes, No]: ${f.ref}`)
    }
  } finally {
    await browser.close()
  }
})

test('inventory: prev_travel radio rblPREV_US_TRAVEL_IND is marked triggersPostback', async () => {
  const html = readFileSync('dom-snapshots/prev_us_travel--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inv = await extractPageInventory(page)

    // At least one radio on the prev_travel page should trigger a postback
    const postbackRadios = inv.fields.filter((f) => f.kind === 'radio' && f.triggersPostback)
    assert.ok(postbackRadios.length > 0, 'At least one radio should trigger a postback on prev_travel page')
  } finally {
    await browser.close()
  }
})

test('inventory: repeat rows have correct 1-based row numbers', async () => {
  const html = readFileSync('dom-snapshots/work_previous--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inv = await extractPageInventory(page)

    // All repeat-row fields should have row >= 1
    const repeatedFields = inv.fields.filter((f) => f.row !== null)
    assert.ok(repeatedFields.length > 0, 'Should have repeat-row fields on work_previous page')
    for (const f of repeatedFields) {
      assert.ok(f.row >= 1, `Row occurrence should be >= 1, got ${f.row} for ref ${f.ref}`)
    }
  } finally {
    await browser.close()
  }
})

test('diffInventory: detects added fields between two inventories', () => {
  const prev = {
    fields: [
      { ref: 'tbxName', kind: 'text', label: 'Name', value: '', disabled: false, required: true },
    ],
  }
  const next = {
    fields: [
      { ref: 'tbxName', kind: 'text', label: 'Name', value: 'COHEN', disabled: false, required: true },
      { ref: 'tbxCity', kind: 'text', label: 'City', value: '', disabled: false, required: true },
    ],
  }
  const diff = diffInventory(prev, next)
  assert.equal(diff.added.length, 1)
  assert.equal(diff.added[0].ref, 'tbxCity')
  assert.equal(diff.removed.length, 0)
  assert.equal(diff.changed.length, 1)
  assert.equal(diff.changed[0].ref, 'tbxName')
})

test('diffInventory: detects removed fields', () => {
  const prev = {
    fields: [
      { ref: 'tbxName', kind: 'text', label: 'Name', value: '', disabled: false },
      { ref: 'tbxHidden', kind: 'text', label: 'Hidden', value: '', disabled: false },
    ],
  }
  const next = {
    fields: [
      { ref: 'tbxName', kind: 'text', label: 'Name', value: '', disabled: false },
    ],
  }
  const diff = diffInventory(prev, next)
  assert.equal(diff.removed.length, 1)
  assert.equal(diff.removed[0].ref, 'tbxHidden')
})

test('findUnplannedRequired: excludes planned refs and disabled/optional fields', () => {
  const inventory = {
    fields: [
      { ref: 'tbxA', kind: 'text', value: '', required: true,  disabled: false },
      { ref: 'tbxB', kind: 'text', value: '', required: true,  disabled: false },
      { ref: 'tbxC', kind: 'text', value: '', required: false, disabled: false },
      { ref: 'tbxD', kind: 'text', value: '', required: true,  disabled: true  },
      { ref: 'tbxE', kind: 'text', value: 'filled', required: true, disabled: false },
    ],
  }
  const unplanned = findUnplannedRequired(inventory, ['tbxA'])
  assert.deepEqual(unplanned.map((f) => f.ref), ['tbxB'])
})

test('inventory: signature changes when field value changes', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <form>
        <label for="ctl00_SiteContentPlaceHolder_FormView1_tbxAPP_SURNAME">Surnames</label>
        <input id="ctl00_SiteContentPlaceHolder_FormView1_tbxAPP_SURNAME" type="text" value="">
      </form>
    `)
    const inv1 = await extractPageInventory(page)

    await page.locator('#ctl00_SiteContentPlaceHolder_FormView1_tbxAPP_SURNAME').fill('COHEN')
    const inv2 = await extractPageInventory(page)

    assert.notEqual(inv1.signature, inv2.signature, 'Signature should change after value update')
  } finally {
    await browser.close()
  }
})

// ─── Synchronized tests ───────────────────────────────────────────────────────

test('spouse and every travel companion are synchronized deterministically', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const spousePage = await browser.newPage()
    await spousePage.setContent(`
      <input id="ctl00_SiteContentPlaceHolder_FormView1_tbxSpouseSurname" value="MANOVA COHEN">
      <input id="ctl00_SiteContentPlaceHolder_FormView1_tbxSpouseGivenName" value="Eden">
    `)
    const spouseChanged = await syncSpouseNameFromSource(spousePage, [
      '🟦 SPOUSE INFORMATION',
      'Spouse Surname: COHEN',
      'Spouse Given Name: Natalie',
    ].join('\n'))
    assert.equal(spouseChanged, true)
    assert.equal(
      await spousePage.locator('input[id$="tbxSpouseSurname"]').inputValue(),
      'COHEN',
    )
    assert.equal(
      await spousePage.locator('input[id$="tbxSpouseGivenName"]').inputValue(),
      'Natalie',
    )

    const companionsPage = await browser.newPage()
    await companionsPage.setContent(`
      <div id="rows"></div>
      <a id="TravelCompan_InsertButton" title="Add Another" href="#" onclick="addRow(); return false;">Add Another</a>
      <script>
        function addRow() {
          const index = document.querySelectorAll('input[id*="TravelCompan"][id*="Surname"]').length;
          document.querySelector('#rows').insertAdjacentHTML('beforeend', \`
            <label for="TravelCompan_\${index}_Surname">Surnames of Person Traveling With You</label>
            <input id="TravelCompan_\${index}_Surname">
            <label for="TravelCompan_\${index}_Given">Given Names of Person Traveling With You</label>
            <input id="TravelCompan_\${index}_Given">
            <label for="TravelCompan_\${index}_Relationship">Relationship with Person</label>
            <select id="TravelCompan_\${index}_Relationship">
              <option value=""></option>
              <option value="SPOUSE">SPOUSE</option>
              <option value="CHILD">CHILD</option>
              <option value="OTHER">OTHER</option>
            </select>
          \`);
        }
        addRow();
      </script>
    `)
    const companionSection = [
      '🟦 TRAVEL COMPANIONS',
      'Surnames of Person Traveling With You: COHEN',
      'Given Names of Person Traveling With You: Natalie',
      'Relationship: Spouse',
      'Surnames of Person Traveling With You: COHEN',
      'Given Names of Person Traveling With You: Shira',
      'Relationship: Child',
    ].join('\n')
    const companionsChanged = await syncTravelCompanionsFromSource(
      companionsPage,
      companionSection,
    )
    assert.equal(companionsChanged, true)
    assert.deepEqual(
      await companionsPage
        .locator('input[id*="TravelCompan"][id*="Given"]')
        .evaluateAll((elements) => elements.map((element) => element.value)),
      ['Natalie', 'Shira'],
    )
    assert.deepEqual(
      await companionsPage
        .locator('select[id*="TravelCompan"][id*="Relationship"]')
        .evaluateAll((elements) => elements.map((element) => element.value)),
      ['SPOUSE', 'CHILD'],
    )
  } finally {
    await browser.close()
  }
})

const form8PrevTravel = [
  '🟦 PREVIOUS U.S. TRAVEL',
  'Have you ever been in the United States? Yes',
  'Arrival Date: 19/01/2019',
  'Length of Stay: 21 days',
  'Arrival Date: 17/01/2018',
  'Length of Stay: 1 month',
  'Do you or did you ever hold a U.S. Driver’s License? No',
  'Have you ever been issued a U.S. Visa? Yes',
  'Date Last Visa Was Issued: 07/11/2016',
  'Visa Number: L9066286',
  'Are you applying for the same type of visa? Yes',
  'Are you applying in the same country or location where the visa above was issued, and is this country or location your place of principal of residence? Yes',
  'Have you been ten-printed? No',
  'Has your U.S. Visa ever been lost or stolen? No',
  'Has your U.S. Visa ever been cancelled or revoked? No',
].join('\n')

test('previous U.S. travel visits and visa are parsed from source', () => {
  const parsed = parsePrevTravelFromSource(form8PrevTravel)
  assert.equal(parsed.beenInUs, true)
  assert.equal(parsed.issuedVisa, true)
  assert.equal(parsed.driverLicense, false)
  assert.deepEqual(parsed.visits, [
    { date: '19/01/2019', quantity: '21', unit: 'Day(s)' },
    { date: '17/01/2018', quantity: '1', unit: 'Month(s)' },
  ])
  assert.equal(parsed.visaDate, '07/11/2016')
  assert.equal(parsed.visaNumber, 'L9066286')
  assert.equal(parsed.sameType, true)
  assert.equal(parsed.tenPrinted, false)
})

test('CEAC 5-visit cap keeps the most recent previous U.S. visits', () => {
  const visits = parsePrevTravelFromSource([
    'Arrival Date: 19/01/2019',
    'Length of Stay: 21 days',
    'Arrival Date: 17/01/2018',
    'Length of Stay: 1 month',
    'Arrival Date: 27/12/2019',
    'Length of Stay: 2 months',
    'Arrival Date: 27/12/2020',
    'Length of Stay: 2 months',
    'Arrival Date: 19/02/2022',
    'Length of Stay: 1 month',
    'Arrival Date: 30/11/2023',
    'Length of Stay: 1 month',
  ].join('\n')).visits
  assert.equal(visits.length, 6)
  assert.deepEqual(
    capPrevUsVisits(visits).map((visit) => visit.date),
    ['19/01/2019', '27/12/2019', '27/12/2020', '19/02/2022', '30/11/2023'],
  )
})

test('social media identifiers are extracted from URLs', () => {
  assert.equal(
    socialMediaIdentifier('https://www.facebook.com/omishel?mibextid=wwXIfr&rdid=abc'),
    'omishel',
  )
  assert.equal(
    socialMediaIdentifier('https://www.instagram.com/odettemishel?igsh=YnFteXdvaTBhcG5w'),
    'odettemishel',
  )
  const accounts = parseSocialMediaFromSource([
    'Facebook: https://www.facebook.com/omishel?mibextid=wwXIfr',
    'Instagram: https://www.instagram.com/odettemishel?igsh=abc',
  ].join('\n'))
  assert.deepEqual(accounts, [
    { platform: 'FACEBOOK', identifier: 'omishel' },
    { platform: 'INSTAGRAM', identifier: 'odettemishel' },
  ])
})

test('social media snapshot selects NONE when the source used no platforms', async () => {
  const html = readFileSync('dom-snapshots/address--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const changed = await syncSocialMediaFromSource(page, [
      'SOCIAL MEDIA',
      'Have you used social media platforms in the last 5 years? No',
      'None',
    ].join('\n'))
    assert.equal(changed, true)
    assert.equal(
      await page.locator('select[id*="ddlSocialMedia"]').first().evaluate(
        (el) => el.options[el.selectedIndex]?.text.trim().toUpperCase(),
      ),
      'NONE',
    )
  } finally {
    await browser.close()
  }
})

test('packed U.S. stay addresses split street from city/state/ZIP', () => {
  assert.deepEqual(
    parsePackedUsAddress('2508 Cardamon Avenue, Hollywood, FL 33026, United States'),
    {
      street: '2508 Cardamon Avenue',
      city: 'Hollywood',
      state: 'FL',
      zip: '33026',
    },
  )
  assert.equal(parsePackedUsAddress('2508 Cardamon Avenue').street, '2508 Cardamon Avenue')
})

test('travel street fill strips packed city/state/ZIP before maxlength truncation', async () => {
  const html = readFileSync('dom-snapshots/travel--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await executeAction(page, {
      type: 'fill',
      label: 'Street Address (Line 1)',
      value: '2508 Cardamon Avenue, Hollywood, FL 33026, United States',
    })
    assert.equal(
      await page.locator('input[id$="tbxStreetAddress1"]').inputValue(),
      '2508 Cardamon Avenue',
    )
    assert.equal(await page.locator('input[id$="tbZIPCode"]').inputValue(), '33026')
  } finally {
    await browser.close()
  }
})

test('prev_travel snapshot is filled from source including visa number', async () => {
  const html = readFileSync('dom-snapshots/prev_us_travel--expanded.html', 'utf8')
  const oneVisit = [
    '🟦 PREVIOUS U.S. TRAVEL',
    'Have you ever been in the United States? Yes',
    'Arrival Date: 19/01/2019',
    'Length of Stay: 21 days',
    'Do you or did you ever hold a U.S. Driver’s License? No',
    'Have you ever been issued a U.S. Visa? Yes',
    'Date Last Visa Was Issued: 07/11/2016',
    'Visa Number: L9066286',
    'Are you applying for the same type of visa? Yes',
    'Have you been ten-printed? No',
  ].join('\n')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const changed = await syncPrevTravelFromSource(page, oneVisit)
    assert.equal(changed, true)
    assert.equal(
      await page.locator('input[id*="tbxPREV_US_VISIT_LOS"]').first().inputValue(),
      '21',
    )
    assert.equal(
      await page.locator('input[id$="tbxPREV_VISA_FOIL_NUMBER"]').inputValue(),
      'L9066286',
    )
    await executeAction(page, {
      type: 'radio',
      label: 'Have you ever been in the U.S.?',
      value: 'No',
      ref: 'rblPREV_US_TRAVEL_IND',
    })
    assert.equal(
      await page.locator('input[id$="rblPREV_US_TRAVEL_IND_1"]').isChecked().catch(() => false),
      false,
    )
  } finally {
    await browser.close()
  }
})

test('social media snapshot fills Facebook and Instagram handles', async () => {
  const html = readFileSync('dom-snapshots/address_phone--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const changed = await syncSocialMediaFromSource(page, [
      'Facebook: https://www.facebook.com/omishel',
      'Instagram: https://www.instagram.com/odettemishel',
    ].join('\n'))
    assert.equal(changed, true)
    assert.deepEqual(
      await page.locator('select[id*="ddlSocialMedia"]').evaluateAll((els) =>
        els.slice(0, 2).map((el) => el.options[el.selectedIndex]?.text.trim().toUpperCase()),
      ),
      ['FACEBOOK', 'INSTAGRAM'],
    )
    assert.deepEqual(
      await page.locator('input[id*="tbxSocialMediaIdent"]').evaluateAll((els) =>
        els.slice(0, 2).map((el) => el.value),
      ),
      ['omishel', 'odettemishel'],
    )
  } finally {
    await browser.close()
  }
})

test('stay address sync does not rewrite a street that is already saved', async () => {
  const html = `
    <input id="ctl00_tbxStreetAddress1" maxlength="40" />
    <input id="ctl00_tbxCity" maxlength="20" />
    <select id="ctl00_ddlTravelState">
      <option value="">SELECT</option>
      <option value="NY">NEW YORK</option>
    </select>
    <input id="ctl00_tbZIPCode" maxlength="10" />
  `
  const source = [
    'Street Address (Line 1): 1217 Bay Park Pl Far Rockaway, NY 11691 United States',
    'City: Far Rockaway',
    'State: NY',
    'ZIP Code: 11691',
  ].join('\n')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    assert.equal(await syncUsStayAddressFromSource(page, source), true)
    assert.equal(await page.locator('input[id$="tbxStreetAddress1"]').inputValue(), '1217 Bay Park Pl')
    assert.equal(await page.locator('input[id$="tbxCity"]').inputValue(), 'Far Rockaway')
    assert.equal(await page.locator('select[id$="ddlTravelState"]').inputValue(), 'NY')
    assert.equal(await page.locator('input[id$="tbZIPCode"]').inputValue(), '11691')
    assert.equal(await syncUsStayAddressFromSource(page, source), false)
  } finally {
    await browser.close()
  }
})

test('stay address sync treats a maxlength-clipped street as already filled', async () => {
  const html = `
    <input id="ctl00_tbxStreetAddress1" maxlength="40" value="" />
    <input id="ctl00_tbxCity" maxlength="20" />
    <select id="ctl00_ddlTravelState"><option value="FL">FLORIDA</option></select>
    <input id="ctl00_tbZIPCode" maxlength="10" value="33026" />
  `
  const street = '1234567890123456789012345678901234567890EXTRA'
  const source = [
    `Street Address (Line 1): ${street}`,
    'City: Cooper City',
    'State: FL',
    'ZIP Code: 33026',
  ].join('\n')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    assert.equal(await syncUsStayAddressFromSource(page, source), true)
    assert.equal(
      await page.locator('input[id$="tbxStreetAddress1"]').inputValue(),
      street.slice(0, 40),
    )
    assert.equal(await syncUsStayAddressFromSource(page, source), false)
  } finally {
    await browser.close()
  }
})

test('travel snapshot stay address fills Cooper City, FL, and ZIP', async () => {
  const html = readFileSync('dom-snapshots/travel--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const changed = await syncUsStayAddressFromSource(page, [
      '🟦 TRAVEL INFORMATION',
      'Street Address (Line 1): 2508 Cardamon Avenue',
      'City: Cooper City',
      'State: FL',
      'ZIP Code: 33026',
    ].join('\n'))
    assert.equal(changed, true)
    assert.equal(await page.locator('input[id$="tbxStreetAddress1"]').inputValue(), '2508 Cardamon Avenue')
    assert.equal(await page.locator('input[id$="tbxCity"]').inputValue(), 'Cooper City')
    assert.equal(await page.locator('select[id$="ddlTravelState"]').inputValue(), 'FL')
    assert.equal(await page.locator('input[id$="tbZIPCode"]').inputValue(), '33026')
  } finally {
    await browser.close()
  }
})

test('intended stay parses quantity and unit from source lines', () => {
  assert.deepEqual(
    parseIntendedStayFromSource('Intended Length of Stay: 3 weeks'),
    { quantity: '3', unit: 'Week(s)' },
  )
  assert.deepEqual(
    parseIntendedStayFromSource('Intended Length of Stay in U.S.: 5 months'),
    { quantity: '5', unit: 'Month(s)' },
  )
  assert.deepEqual(
    parseIntendedStayFromSource('', { intended_length_of_stay: '1 Month(s)' }),
    { quantity: '1', unit: 'Month(s)' },
  )
})

test('intended stay fills quantity and unit when the No-plans fields are on the page', async () => {
  const html = `
    <input id="ctl00_SiteContentPlaceHolder_FormView1_tbxTRAVEL_LOS" type="text" value="">
    <select id="ctl00_SiteContentPlaceHolder_FormView1_ddlTRAVEL_LOS_CD">
      <option value="">-SELECT ONE-</option>
      <option value="W">Week(s)</option>
      <option value="M">Month(s)</option>
    </select>
  `
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const changed = await syncIntendedStayFromSource(
      page,
      'Intended Length of Stay: 3 weeks',
      { intended_length_of_stay: '3 weeks' },
    )
    assert.equal(changed, true)
    assert.equal(await page.locator('input[id$="tbxTRAVEL_LOS"]').inputValue(), '3')
    assert.equal(
      await page.locator('select[id$="ddlTRAVEL_LOS_CD"]').evaluate(
        (el) => el.options[el.selectedIndex]?.text.trim(),
      ),
      'Week(s)',
    )
  } finally {
    await browser.close()
  }
})

test('form9 additional background lists every language and country', () => {
  const parsed = parseApplicantSource(readFileSync('people/form9.txt', 'utf8'))
  const section = filterTranslatedText(parsed.text, 'work_additional')
  assert.deepEqual(parseLanguagesFromSource(section), ['Hebrew', 'English'])
  assert.deepEqual(parseCountriesVisitedFromSource(section), [
    'Thailand',
    'Singapore',
    'Philippines',
    'Spain',
    'Netherlands',
    'Romania',
    'Georgia',
    'Greece',
    'Hungary',
  ])
})

test('form9 previous-work cities keep Elbit in Hod HaSharon', () => {
  const parsed = parseApplicantSource(readFileSync('people/form9.txt', 'utf8'))
  const section = filterTranslatedText(parsed.text, 'work_previous')
  assert.deepEqual(
    parsePreviousEmployerCitiesFromSource(section, parsed.answerSheet?.work_previous),
    ['Hod HaSharon'],
  )
  assert.deepEqual(
    parseEducationCitiesFromSource(section, parsed.answerSheet?.work_previous),
    ['Modiin'],
  )
})

test('bare City fill does not overwrite previous employer city', async () => {
  const html = `<!DOCTYPE html><html><body>
    <input id="ctl00_SiteContentPlaceHolder_FormView1_tbxEmpCity" value="Hod HaSharon">
    <input id="ctl00_SiteContentPlaceHolder_FormView1_dtlPrevEduc_ctl00_tbxSchoolName">
    <input id="ctl00_SiteContentPlaceHolder_FormView1_dtlPrevEduc_ctl00_tbxSchoolCity">
  </body></html>`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await executeAction(page, {
      type: 'fill',
      label: 'City',
      value: 'Modiin',
    })
    assert.equal(await page.locator('input[id$="tbxEmpCity"]').inputValue(), 'Hod HaSharon')
    assert.equal(await page.locator('input[id$="tbxSchoolCity"]').inputValue(), 'Modiin')
  } finally {
    await browser.close()
  }
})

test('bare City fill with employer ref does not write the school city', async () => {
  const html = `<!DOCTYPE html><html><body>
    <input id="ctl00_SiteContentPlaceHolder_FormView1_tbxEmpCity">
    <input id="ctl00_SiteContentPlaceHolder_FormView1_dtlPrevEduc_ctl00_tbxSchoolName" value="Ort Ironi D">
    <input id="ctl00_SiteContentPlaceHolder_FormView1_dtlPrevEduc_ctl00_tbxSchoolCity">
  </body></html>`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await executeAction(page, {
      type: 'fill',
      label: 'City',
      value: 'Hod HaSharon',
      ref: 'tbxEmpCity',
    })
    await executeAction(page, {
      type: 'fill',
      label: 'Education City',
      value: 'Modiin',
      ref: 'dtlPrevEduc_ctl00_tbxSchoolCity',
      occurrence: 1,
    })
    assert.equal(await page.locator('input[id$="tbxEmpCity"]').inputValue(), 'Hod HaSharon')
    assert.equal(await page.locator('input[id$="tbxSchoolCity"]').inputValue(), 'Modiin')
  } finally {
    await browser.close()
  }
})

test('start application clicks btnNewApp, not the instruction text', async () => {
  const html = `<!DOCTYPE html><html><body>
    <p id="instructions">Enter the code, then click START AN APPLICATION.</p>
    <select id="ctl00_SiteContentPlaceHolder_ucLocationSearch_ddlLocation">
      <option value="TEL" selected>ISRAEL, TEL AVIV</option>
    </select>
    <input id="ctl00_SiteContentPlaceHolder_ucLocationSearch_txtcaptcha" value="9VUN6C">
    <input type="image" id="ctl00_SiteContentPlaceHolder_ucLocationSearch_btnNewApp"
      name="ctl00$SiteContentPlaceHolder$ucLocationSearch$btnNewApp"
      alt=""
      style="width:220px;height:44px;background:#c00"
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
    <script>
      document.getElementById('instructions').addEventListener('click', () => {
        window.__clicked = 'instructions'
      })
      document.getElementById('ctl00_SiteContentPlaceHolder_ucLocationSearch_btnNewApp')
        .addEventListener('click', (event) => {
          event.preventDefault()
          window.__clicked = 'btnNewApp'
        })
    </script>
  </body></html>`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const clicked = await clickStartApplication(page)
    assert.equal(clicked, true)
    assert.equal(await page.evaluate(() => window.__clicked), 'btnNewApp')
    await page.evaluate(() => { window.__clicked = null })
    await executeAction(page, { type: 'click', text: 'START AN APPLICATION' })
    assert.equal(await page.evaluate(() => window.__clicked), 'btnNewApp')
  } finally {
    await browser.close()
  }
})

test('disabled lnkNew is enabled and posted back', async () => {
  const html = `<!DOCTYPE html><html><body>
    <p id="instructions">Enter the code, then click START AN APPLICATION.</p>
    <a onclick="return ValidNavigation();" id="ctl00_SiteContentPlaceHolder_lnkNew"
      disabled="disabled" role="Button">START AN APPLICATION</a>
    <script>
      window.needToConfirm = true
      window.ValidNavigation = function ValidNavigation() { return true }
      window.__doPostBack = function (target) { window.__clicked = target }
      document.getElementById('instructions').addEventListener('click', () => {
        window.__clicked = 'instructions'
      })
    </script>
  </body></html>`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const clicked = await clickStartApplication(page)
    assert.equal(clicked, true)
    assert.equal(
      await page.evaluate(() => window.__clicked),
      'ctl00$SiteContentPlaceHolder$lnkNew',
    )
  } finally {
    await browser.close()
  }
})

test('CEAC leave-site prompt flag stays off', async () => {
  const html = `<!DOCTYPE html><html><body><p>form</p></body></html>`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await disarmCeacUnload(page)
    const stillOff = await page.evaluate(() => {
      window.needToConfirm = true
      window.onbeforeunload = () => 'Leave site?'
      if (typeof window.setDirty === 'function') window.setDirty()
      return {
        needToConfirm: window.needToConfirm,
        beforeunload: window.onbeforeunload,
      }
    })
    assert.equal(stillOff.needToConfirm, false)
    assert.equal(stillOff.beforeunload, null)
  } finally {
    await browser.close()
  }
})

test('U.S. contact person DO NOT KNOW ticks the name checkbox, not the inputs', async () => {
  const html = readFileSync('dom-snapshots/us_point_of_contact--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => { window.__doPostBack = () => {} })
    await executeAction(page, {
      type: 'fill',
      label: 'Surnames',
      value: 'DO NOT KNOW',
      ref: 'tbxUS_POC_SURNAME',
    })
    assert.equal(await page.locator('input[id$="cbxUS_POC_NAME_NA"]').isChecked(), true)
    assert.equal(await page.locator('input[id$="tbxUS_POC_SURNAME"]').inputValue(), '')
  } finally {
    await browser.close()
  }
})

test('U.S. contact organization fill checks person Do Not Know when names are empty', async () => {
  const html = readFileSync('dom-snapshots/us_point_of_contact--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => { window.__doPostBack = () => {} })
    await executeAction(page, {
      type: 'fill',
      label: 'Organization Name',
      value: 'HOTELS',
      ref: 'tbxUS_POC_ORGANIZATION',
    })
    assert.equal(await page.locator('input[id$="tbxUS_POC_ORGANIZATION"]').inputValue(), 'HOTELS')
    assert.equal(await page.locator('input[id$="cbxUS_POC_NAME_NA"]').isChecked(), true)
  } finally {
    await browser.close()
  }
})

test('employer name fill drops the Ltd. period CEAC rejects', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(
      '<input id="ctl00_SiteContentPlaceHolder_FormView1_tbxEmpName" value="">',
    )
    await executeAction(page, {
      type: 'fill',
      label: 'Employer Name',
      value: 'ELBIT SYSTEMS LTD.',
      ref: 'tbxEmpName',
    })
    assert.equal(
      await page.locator('input[id$="tbxEmpName"]').inputValue(),
      'ELBIT SYSTEMS LTD',
    )
  } finally {
    await browser.close()
  }
})

test('company payer sync fills the organization, relationship, and Israel address', async () => {
  const source = [
    '🟦 TRAVEL INFORMATION',
    '**PERSON/ENTITY PAYING FOR TRIP**',
    'Who is paying for the trip? Other Company/Organization',
    'Name of Company/Organization Paying for Trip: Ministry of the Negev Galilee and National Resilience',
    'Telephone Number: 972522964588',
    'Relationship to You: Advisor to the Ministry Director General',
    'Street Address (Line 1): Kanfei Nesharim 5',
    'City: Jerusalem',
    'State/Province: DOES NOT APPLY',
    'Postal Zone/ZIP Code: 9546412',
    'Country/Region: Israel',
  ].join('\n')
  assert.equal(parsePayerCompanyFromSource(source).city, 'Jerusalem')
  assert.equal(parsePayerCompanyFromSource(source).name.startsWith('Ministry'), true)

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <div id="ctl00_SiteContentPlaceHolder_FormView1_upnlPayer">
        <label for="org">Name of Company/Organization Paying for Trip</label>
        <input id="org" maxlength="33" value="ADVISOR TO THE MINISTRY DIRECTOR">
        <label for="tel">Telephone Number</label>
        <input id="tel" value="972522964588">
        <label for="rel">Relationship to You</label>
        <input id="rel" maxlength="40" value="">
        <label for="st1">Street Address (Line 1)</label>
        <input id="st1" maxlength="40" value="">
        <label for="city">City</label>
        <input id="city" maxlength="20" value="">
        <label for="state">State/Province</label>
        <input id="state" value="">
        <input id="stateNa" type="checkbox">
        <label for="stateNa">Does Not Apply</label>
        <label for="zip">Postal Zone/ZIP Code</label>
        <input id="zip" value="">
        <input id="zipNa" type="checkbox">
        <label for="zipNa">Does Not Apply</label>
        <label for="ctry">Country/Region</label>
        <select id="ctry">
          <option value="">- SELECT ONE -</option>
          <option value="ISRL">ISRAEL</option>
        </select>
      </div>
    `)
    assert.equal(await syncPayerCompanyFromSource(page, source), true)
    assert.equal(await page.locator('#org').inputValue(), 'Ministry of the Negev Galilee and')
    assert.equal(await page.locator('#rel').inputValue(), 'Advisor to the Ministry Director General')
    assert.equal(await page.locator('#st1').inputValue(), 'Kanfei Nesharim 5')
    assert.equal(await page.locator('#city').inputValue(), 'Jerusalem')
    assert.equal(await page.locator('#zip').inputValue(), '9546412')
    assert.equal(await page.locator('#ctry').inputValue(), 'ISRL')
    assert.equal(await page.locator('#stateNa').isChecked(), true)
    assert.equal(await page.locator('#zipNa').isChecked(), false)
    assert.equal(await syncPayerCompanyFromSource(page, source), false)
  } finally {
    await browser.close()
  }
})

test('company payer fields stay inside the payer panel', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <label for="stayStreet">Street Address (Line 1)</label>
      <input id="stayStreet" type="text" value="">
      <label for="stayCity">City</label>
      <input id="stayCity" type="text" value="">
      <input id="cbexAPP_POB_ST_PROVINCE_NA" type="checkbox">
      <div id="ctl00_SiteContentPlaceHolder_FormView1_upnlPayer">
        <div class="field">
          <label for="org">Name of Company/Organization Paying for Trip</label>
          <input id="org" type="text">
        </div>
        <div class="field">
          <label for="tel">Telephone Number</label>
          <input id="tel" type="text">
        </div>
        <div class="field">
          <label for="rel">Relationship to You</label>
          <input id="rel" type="text">
        </div>
        <div class="field">
          <label for="st1">Street Address (Line 1)</label>
          <input id="st1" type="text">
        </div>
        <div class="field">
          <label for="city">City</label>
          <input id="city" type="text">
        </div>
        <div class="field">
          <label for="state">State/Province</label>
          <input id="state" type="text">
          <input id="stateNa" type="checkbox">
          <label for="stateNa">Does Not Apply</label>
        </div>
        <div class="field">
          <label for="zip">Postal Zone/ZIP Code</label>
          <input id="zip" type="text">
        </div>
        <div class="field">
          <label for="ctry">Country/Region</label>
          <select id="ctry">
            <option value="">- SELECT ONE -</option>
            <option value="ISRL">ISRAEL</option>
          </select>
        </div>
      </div>
    `)
    await executeAction(page, {
      type: 'fill',
      label: 'Name of Company/Organization Paying for Trip',
      value: 'Ministry of the Negev Galilee and National Resilience State of Israel',
    })
    await executeAction(page, {
      type: 'fill',
      label: 'Telephone Number of Company Paying',
      value: '972522964588',
    })
    await executeAction(page, {
      type: 'fill',
      label: 'Relationship of Company Paying',
      value: 'Advisor to the Ministry Director General',
    })
    await executeAction(page, {
      type: 'fill',
      label: 'Payer Company Street Address (Line 1)',
      value: 'Kanfei Nesharim 5',
    })
    await executeAction(page, {
      type: 'fill',
      label: 'Payer Company City',
      value: 'Jerusalem',
    })
    await executeAction(page, {
      type: 'check',
      label: 'Does Not Apply',
      fieldLabel: 'Payer Company State/Province',
    })
    await executeAction(page, {
      type: 'fill',
      label: 'Payer Company Postal Zone/ZIP Code',
      value: '9546412',
    })
    await executeAction(page, {
      type: 'selectOption',
      label: 'Payer Company Country/Region',
      value: 'ISRAEL',
    })
    assert.equal(await page.locator('#org').inputValue(), 'Ministry of the Negev Galilee and National Resilience State of Israel')
    assert.equal(await page.locator('#tel').inputValue(), '972522964588')
    assert.equal(await page.locator('#rel').inputValue(), 'Advisor to the Ministry Director General')
    assert.equal(await page.locator('#st1').inputValue(), 'Kanfei Nesharim 5')
    assert.equal(await page.locator('#city').inputValue(), 'Jerusalem')
    assert.equal(await page.locator('#zip').inputValue(), '9546412')
    assert.equal(await page.locator('#ctry').inputValue(), 'ISRL')
    assert.equal(await page.locator('#stateNa').isChecked(), true)
    assert.equal(await page.locator('#stayStreet').inputValue(), '')
    assert.equal(await page.locator('#stayCity').inputValue(), '')
    assert.equal(await page.locator('#cbexAPP_POB_ST_PROVINCE_NA').isChecked(), false)
  } finally {
    await browser.close()
  }
})
