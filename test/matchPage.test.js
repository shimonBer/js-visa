import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  filterTranslatedText,
  hasCanonicalSections,
  sourceUsedSocialMedia,
} from '../autofill/agent.js'
import { DS160_FIELDS, DS160_UNKNOWN_CHECKBOXES, isMarkerValue } from '../autofill/ds160-fields.js'
import { extractPageInventory } from '../autofill/page-inventory.js'
import { parseApplicantSource } from '../autofill/parse-applicant-source.js'
import {
  MATCHER_PAGES,
  securityAnswersAreAllNo,
  flattenAnswerSheet,
  isFieldFilled,
  isIntendedStayLengthField,
  matchPage,
  normalizeCountryName,
  normalizeKey,
  parseSourceAnswers,
  revealedFieldsToFill,
  refCore,
} from '../autofill/match-page.js'

const SOURCE = readFileSync('people/form8.txt', 'utf8')

/** Extract the inventory for a snapshot and match it against form8's answers. */
async function matchSnapshot(snapshot, pageContext, { answerSheet } = {}) {
  const html = readFileSync(`dom-snapshots/${snapshot}`, 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const answers = filterTranslatedText(SOURCE, pageContext)
    return { inventory, result: matchPage({ pageContext, inventory, answers, answerSheet }) }
  } finally {
    await browser.close()
  }
}

const byRef = (actions, ref) => actions.find((action) => action.ref === ref)

// ─── Marker values ───────────────────────────────────────────────────────────

// The DS-160 validates its inputs, so a literal "N/A" in the ZIP box comes back
// as "ZIP Code is invalid" and the run stalls re-planning the same step. This
// happened live because syncUsStayAddressFromSource writes to the inputs
// directly and never reaches executeAction's guard.
test('marker answers are never typed, real values are left alone', () => {
  const markers = [
    'N/A', 'n/a', 'NA', 'n.a.', 'None', 'nil', 'null', 'unknown', 'missing', 'TBD',
    'Not Relevant', 'NOT APPLICABLE', 'not available', 'not provided', 'irrelevant',
    'Does Not Apply', 'Do Not Know', "doesn't apply",
    // Source documents phrase these as an instruction to the reader, and both
    // spellings have to be caught or the instruction itself gets typed in.
    '✅ Check "Does Not Apply"', 'Check "Does Not Apply"', '*(leave blank)*', 'leave blank',
    'blank', 'no value', 'No Information',
    '-', '—', '?', '', '   ', null, undefined,
  ]
  for (const marker of markers) {
    assert.equal(isMarkerValue(marker), true, `${JSON.stringify(marker)} should be a marker`)
  }

  // "No" is excluded on purpose: it is a real surname, and this guard also
  // covers name fields. Yes/No answers arrive as radio actions, not fills.
  const real = ['No', 'Noa', 'Nowak', 'Nilsson', 'None Street', 'Null Island',
    '33143', '0', 'B1/B2', 'GALLIA', 'Tel Aviv', '+972-548024656']
  for (const value of real) {
    assert.equal(isMarkerValue(value), false, `${JSON.stringify(value)} should be fillable`)
  }
})

// ─── Section filtering ───────────────────────────────────────────────────────

test('a sectioned document never offers one page another page\'s answers', () => {
  const doc = [
    '🟦 PASSPORT',
    'Passport Number: 12345678',
    '',
    '🟦 FAMILY',
    "Father's Date of Birth: 1940-03-04",
  ].join('\n')

  assert.match(filterTranslatedText(doc, 'passport'), /12345678/)

  // The document has no spouse section. Handing back the whole text instead
  // would let the spouse page read the father's date of birth as the spouse's.
  assert.equal(filterTranslatedText(doc, 'spouse'), '')
})

test('an unsectioned document is recognized as unsplittable', () => {
  assert.equal(hasCanonicalSections('## STEP 1\n| Field | Value |'), false)
  assert.equal(hasCanonicalSections('🟦 PASSPORT\nPassport Number: 1'), true)
  assert.equal(hasCanonicalSections('PERSONAL INFORMATION 1\nSurname: X'), true)
})

// ─── Source parsing ──────────────────────────────────────────────────────────

test('parseSourceAnswers: reads both "Label: value" and "Question? answer" lines', () => {
  const entries = parseSourceAnswers([
    'Surname: MISHEL',
    'Have you ever used other names? No',
    'Date of Birth: 26/11/1962',
  ].join('\n'))

  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.value]),
    [
      ['Surname', 'MISHEL'],
      ['Have you ever used other names?', 'No'],
      ['Date of Birth', '26/11/1962'],
    ],
  )
})

test('parseSourceAnswers: a colon before any "?" wins so URLs stay intact', () => {
  const [entry] = parseSourceAnswers(
    'Instagram: https://www.instagram.com/odettemishel?igsh=YnFteXdvaTBhcG5w',
  )
  assert.equal(entry.key, 'Instagram')
  assert.equal(entry.value, 'https://www.instagram.com/odettemishel?igsh=YnFteXdvaTBhcG5w')
})

test('parseSourceAnswers: skips section headers and valueless lines', () => {
  const entries = parseSourceAnswers([
    '🟦 TRAVEL INFORMATION',
    'Address Where You Will Stay in the U.S.:',
    'City: Cooper City',
  ].join('\n'))

  assert.deepEqual(entries.map((entry) => entry.key), ['City'])
})

test('normalizeKey: curly and straight apostrophes normalize alike', () => {
  assert.equal(normalizeKey('Father’s Surname'), normalizeKey("Father's Surname"))
  assert.equal(normalizeKey('Country / Region of Birth'), 'country region of birth')
})

test('refCore: strips the ASP.NET repeater infix', () => {
  assert.equal(refCore('dlUSRelatives_ctl00_tbxUS_REL_SURNAME'), 'tbxUS_REL_SURNAME')
  assert.equal(refCore('tbxAPP_SURNAME'), 'tbxAPP_SURNAME')
})

test('isFieldFilled: select placeholders do not count as filled', () => {
  assert.equal(isFieldFilled({ kind: 'select', value: '- Select One -' }), false)
  assert.equal(isFieldFilled({ kind: 'select', value: 'PLEASE SELECT A VISA CLASS' }), false)
  assert.equal(isFieldFilled({ kind: 'select', value: 'FEMALE' }), true)
  assert.equal(isFieldFilled({ kind: 'text', value: '' }), false)
  assert.equal(isFieldFilled({ kind: 'text', value: 'MISHEL' }), true)
})

test('flattenAnswerSheet: nested objects and arrays flatten to indexable entries', () => {
  const entries = flattenAnswerSheet({
    surname: 'MISHEL',
    birth: { city_of_birth: 'Bucharest' },
    companions: [{ relationship: 'SPOUSE' }, { relationship: 'CHILD' }],
    languages: ['Hebrew', 'English'],
  })

  const values = (key) =>
    entries.filter((entry) => entry.normKey === normalizeKey(key)).map((entry) => entry.value)

  assert.deepEqual(values('surname'), ['MISHEL'])
  assert.deepEqual(values('city of birth'), ['Bucharest'])
  assert.deepEqual(values('relationship'), ['SPOUSE', 'CHILD'])
  assert.deepEqual(values('languages'), ['Hebrew', 'English'])
})

// ─── personal1 against the real snapshot ─────────────────────────────────────

test('personal1: names, sex, date of birth and place of birth resolve to the right refs', async () => {
  const { result } = await matchSnapshot('personal1--expanded.html', 'personal1')
  const { actions } = result

  assert.deepEqual(byRef(actions, 'tbxAPP_SURNAME'), {
    type: 'fill', label: 'Surnames', value: 'MISHEL', ref: 'tbxAPP_SURNAME',
  })
  assert.deepEqual(byRef(actions, 'tbxAPP_GIVEN_NAME'), {
    type: 'fill', label: 'Given Names', value: 'ODETTE', ref: 'tbxAPP_GIVEN_NAME',
  })
  assert.deepEqual(byRef(actions, 'tbxAPP_FULL_NAME_NATIVE'), {
    type: 'fill', label: 'Full Name in Native Alphabet', value: 'אודט מישל', ref: 'tbxAPP_FULL_NAME_NATIVE',
  })

  // Date groups are reported under the control name shared by their Day/Month/
  // Year parts, and the action carries those three ids so executeAction never has
  // to infer them from the label.
  assert.deepEqual(byRef(actions, 'DOB'), {
    type: 'fill',
    label: 'Date of Birth',
    value: '26/11/1962',
    ref: 'DOB',
    dateParts: { day: 'ddlDOBDay', month: 'ddlDOBMonth', year: 'tbxDOBYear' },
  })

  // Sex and Marital Status are dropdowns whose options are upper-case.
  assert.deepEqual(byRef(actions, 'ddlAPP_GENDER'), {
    type: 'selectOption', label: 'Sex', value: 'FEMALE', ref: 'ddlAPP_GENDER',
  })
  assert.deepEqual(byRef(actions, 'ddlAPP_MARITAL_STATUS'), {
    type: 'selectOption', label: 'Marital Status', value: 'MARRIED', ref: 'ddlAPP_MARITAL_STATUS',
  })

  // "City" and "Country/Region" are too generic to match on the DOM label alone.
  assert.equal(byRef(actions, 'tbxAPP_POB_CITY').value, 'Bucharest')
  assert.equal(byRef(actions, 'ddlAPP_POB_CNTRY').value, 'Romania')
})

test('personal1: an N/A answer checks the field\'s own Does Not Apply box', async () => {
  const { result } = await matchSnapshot('personal1--expanded.html', 'personal1')

  // "State/Province of Birth: N/A" must become a checkbox click, never a fill.
  const check = byRef(result.actions, 'cbexAPP_POB_ST_PROVINCE_NA')
  assert.deepEqual(check, {
    type: 'check',
    label: 'Does Not Apply',
    fieldLabel: 'State/Province',
    ref: 'cbexAPP_POB_ST_PROVINCE_NA',
  })
  assert.equal(byRef(result.actions, 'tbxAPP_POB_ST_PROVINCE'), undefined)
  assert.ok(
    !result.actions.some((action) => /^(n\/a|does not apply)$/i.test(String(action.value || ''))),
    'marker text must never be typed into a field',
  )
})

test('personal1: a postback field is followed by a wait', async () => {
  const { result } = await matchSnapshot('personal1--expanded.html', 'personal1')
  const index = result.actions.findIndex((action) => action.ref === 'ddlAPP_MARITAL_STATUS')

  assert.ok(index >= 0, 'Marital Status should be planned')
  assert.equal(result.actions[index + 1].type, 'wait')
})

test('personal1: the queue ends on the exact Next button text', async () => {
  const { result } = await matchSnapshot('personal1--expanded.html', 'personal1')
  assert.deepEqual(result.nextClick, { type: 'click', text: 'Next: Personal 2' })
})

test('personal1: unresolved required fields are reported for the planner', async () => {
  const { result } = await matchSnapshot('personal1--expanded.html', 'personal1')

  // The snapshot was captured with every conditional branch expanded, so the
  // alias and telecode rows are visible with no matching answer in the source.
  const unresolved = result.unresolvedRequired.map((field) => field.ref)
  assert.ok(unresolved.includes('tbxAPP_TelecodeSURNAME'), `expected telecode gap, got ${unresolved}`)
  assert.ok(
    unresolved.every((ref) => !result.resolvedRefs.includes(ref)),
    'a field cannot be both resolved and unresolved',
  )
})

test('already-filled fields produce no actions', async () => {
  const html = readFileSync('dom-snapshots/personal1--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const answers = filterTranslatedText(SOURCE, 'personal1')

    // Pretend the page came back with every typed field already populated.
    const filled = {
      ...inventory,
      fields: inventory.fields.map((field) =>
        field.kind === 'text' || field.kind === 'date'
          ? { ...field, value: 'ALREADY THERE' }
          : field,
      ),
    }
    const result = matchPage({ pageContext: 'personal1', inventory: filled, answers })

    assert.equal(
      result.actions.filter((action) => action.type === 'fill').length,
      0,
      'filled text fields must not be refilled',
    )
    assert.ok(result.resolvedRefs.includes('tbxAPP_SURNAME'))
  } finally {
    await browser.close()
  }
})

// ─── Other verified pages ────────────────────────────────────────────────────

test('personal2: one Does Not Apply box covers all three U.S. SSN inputs', async () => {
  const { result } = await matchSnapshot('personal2--expanded.html', 'personal2')

  const checks = result.actions.filter((action) => action.ref === 'cbexAPP_SSN_NA')
  assert.equal(checks.length, 1, 'the shared checkbox must only be clicked once')
  for (const ref of ['tbxAPP_SSN1', 'tbxAPP_SSN2', 'tbxAPP_SSN3']) {
    assert.ok(result.resolvedRefs.includes(ref), `${ref} should count as handled`)
    assert.ok(
      !result.unresolvedRequired.some((field) => field.ref === ref),
      `${ref} should not be sent to the planner`,
    )
  }
})

test('family: identical "Surnames" labels resolve to distinct people', async () => {
  const { result } = await matchSnapshot('family--expanded.html', 'family')
  const { actions } = result

  assert.equal(byRef(actions, 'tbxFATHER_SURNAME').value, 'Velt')
  assert.equal(byRef(actions, 'tbxFATHER_GIVEN_NAME').value, 'Elias')
  assert.equal(byRef(actions, 'tbxMOTHER_GIVEN_NAME').value, 'Dina')
  assert.equal(byRef(actions, 'dlUSRelatives_ctl00_tbxUS_REL_SURNAME').value, 'Mishel')
  assert.equal(byRef(actions, 'dlUSRelatives_ctl00_tbxUS_REL_GIVEN_NAME').value, 'Orpaz')

  // Repeat rows must carry their occurrence so executeAction targets the right row.
  assert.equal(byRef(actions, 'dlUSRelatives_ctl00_tbxUS_REL_SURNAME').occurrence, 1)

  // An unknown parent date of birth can only be expressed by ticking "Do Not
  // Know", so the checkbox stands in for the date field. The label comes from the
  // registry, not the source, so it reads the same however the source spelled it.
  const fatherDob = byRef(actions, 'cbxFATHER_DOB_UNK_IND')
  assert.equal(fatherDob.type, 'check')
  assert.equal(fatherDob.fieldLabel, "Father's Date of Birth")
})

test('contact: the packed U.S. address keeps only the street on line 1', async () => {
  const { result } = await matchSnapshot('us_point_of_contact--expanded.html', 'contact')

  assert.equal(byRef(result.actions, 'tbxUS_POC_ADDR_LN1').value, '2508 Cardamon Avenue')
  assert.equal(byRef(result.actions, 'tbxUS_POC_ADDR_CITY').value, 'Cooper City')
  assert.equal(byRef(result.actions, 'ddlUS_POC_ADDR_STATE').value, 'FL')
  assert.equal(byRef(result.actions, 'tbxUS_POC_ADDR_POSTAL_CD').value, '33026')
  assert.equal(byRef(result.actions, 'tbxUS_POC_SURNAME').value, 'Mishel')
  assert.equal(byRef(result.actions, 'tbxUS_POC_GIVEN_NAME').value, 'Orpaz')
  assert.equal(byRef(result.actions, 'cbxUS_POC_ORG_NA_IND').type, 'check')
  assert.equal(byRef(result.actions, 'cbxUS_POC_NAME_NA'), undefined)
})

test('contact: a filled organization checks Do Not Know on the person name', async () => {
  const html = readFileSync('dom-snapshots/us_point_of_contact--expanded.html', 'utf8')
  const answers = [
    '🟦 U.S. CONTACT INFORMATION',
    'Contact Person Surname: DO NOT KNOW',
    'Contact Person Given Name: DO NOT KNOW',
    'Organization Name: HOTELS',
    'Relationship to You: OTHER',
    'Street Address: Hotels',
    'City: New York',
    'State: NY',
    'ZIP Code: DOES NOT APPLY',
    'Phone Number: 0000000000',
    'Email Address: DOES NOT APPLY',
  ].join('\n')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const result = matchPage({ pageContext: 'contact', inventory, answers })

    assert.equal(byRef(result.actions, 'tbxUS_POC_ORGANIZATION').value, 'HOTELS')
    const nameUnknown = byRef(result.actions, 'cbxUS_POC_NAME_NA')
    assert.equal(nameUnknown?.type, 'check')
    assert.equal(byRef(result.actions, 'tbxUS_POC_SURNAME'), undefined)
    assert.equal(byRef(result.actions, 'tbxUS_POC_GIVEN_NAME'), undefined)
    assert.ok(result.resolvedRefs.includes('tbxUS_POC_SURNAME'))
    assert.ok(result.resolvedRefs.includes('tbxUS_POC_GIVEN_NAME'))
    assert.ok(!result.unresolvedRequired.some((field) => /US_POC_(SURNAME|GIVEN_NAME)/.test(field.ref)))
  } finally {
    await browser.close()
  }
})

test('contact: organization without any person-name lines still ticks Do Not Know', async () => {
  const html = readFileSync('dom-snapshots/us_point_of_contact--expanded.html', 'utf8')
  const answers = [
    '🟦 U.S. CONTACT INFORMATION',
    'Organization Name: HOTELS',
    'Relationship to You: OTHER',
    'Street Address: Hotels',
    'City: New York',
    'State: NY',
    'Phone Number: 0000000000',
  ].join('\n')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const result = matchPage({ pageContext: 'contact', inventory, answers })

    assert.equal(byRef(result.actions, 'cbxUS_POC_NAME_NA')?.type, 'check')
    assert.ok(!result.unresolvedRequired.some((field) => /US_POC_(SURNAME|GIVEN_NAME)/.test(field.ref)))
  } finally {
    await browser.close()
  }
})

test('security: all-No answers mark every radio No, including one missing from the source', () => {
  const inventory = {
    fields: [
      { ref: 'rblDisease', kind: 'radio', label: 'Communicable disease?', value: '', required: true },
      { ref: 'rblFutureQuestion', kind: 'radio', label: 'A security question the source does not name', value: '', required: true },
      { ref: 'rblDisorder', kind: 'radio', label: 'Mental disorder?', value: 'No', required: true },
    ],
    buttons: [{ text: 'Next: Security and Background 2' }],
  }
  const answers = [
    'Communicable diseases: No',
    'Mental disorders posing danger: No',
  ].join('\n')

  assert.equal(securityAnswersAreAllNo(answers), true)
  const result = matchPage({ pageContext: 'security', inventory, answers })
  const radios = result.actions.filter((action) => action.type === 'radio')

  assert.deepEqual(radios.map((action) => action.ref), ['rblDisease', 'rblFutureQuestion'])
  assert.ok(radios.every((action) => action.value === 'No'))
  assert.deepEqual(result.unresolvedRequired, [])
  assert.equal(result.nextClick.text, 'Next: Security and Background 2')
})

test('security: a Yes answer is not replaced with No on every radio', () => {
  const inventory = {
    fields: [
      {
        ref: 'rblArrested',
        kind: 'radio',
        label: 'Have you ever been arrested or convicted for any offense or crime, even though subject of a pardon, amnesty, or other similar action?',
        value: '',
        required: true,
      },
      {
        ref: 'rblControlledSubstances',
        kind: 'radio',
        label: 'Have you ever violated, or engaged in a conspiracy to violate, any law relating to controlled substances?',
        value: '',
        required: true,
      },
    ],
    buttons: [{ text: 'Next: Security and Background 3' }],
  }
  const answers = [
    'Have you ever been arrested or convicted for any offense or crime, even though subject of a pardon, amnesty, or other similar action? Yes',
    'Explanation: cannabis possession with a presidential pardon',
    'Have you ever violated, or engaged in a conspiracy to violate, any law relating to controlled substances? No',
  ].join('\n')

  assert.equal(securityAnswersAreAllNo(answers), false)
  const result = matchPage({ pageContext: 'security', inventory, answers })
  assert.equal(byRef(result.actions, 'rblArrested').value, 'Yes')
  assert.equal(byRef(result.actions, 'rblControlledSubstances').value, 'No')
})

test('security: every visible question is answered from its full question text', async () => {
  const { inventory, result } = await matchSnapshot('security_2--expanded.html', 'security')

  const radios = inventory.fields.filter((field) => field.kind === 'radio' && !field.disabled)
  assert.ok(radios.length > 0, 'the security snapshot should expose radio questions')

  const answered = result.actions.filter((action) => action.type === 'radio')
  assert.equal(answered.length, radios.length, 'no security question may be left unanswered')
  for (const action of answered) {
    assert.equal(action.value, 'No')
  }
  assert.deepEqual(result.unresolvedRequired, [])
})

test('spouse: nationality, place of birth and address type resolve', async () => {
  const { result } = await matchSnapshot('spouse--expanded.html', 'spouse')

  assert.equal(byRef(result.actions, 'tbxSpouseSurname').value, 'Mishel')
  assert.equal(byRef(result.actions, 'ddlSpouseNatDropDownList').value, 'Israel')
  assert.equal(byRef(result.actions, 'tbxSpousePOBCity').value, 'Haifa')
  // The source says "Same as home address"; the option text is title-cased.
  assert.equal(byRef(result.actions, 'ddlSpouseAddressType').value, 'Same as Home Address')
})

test('Israeli nationality maps to Israel; N/A birth country falls back to nationality', async () => {
  assert.equal(normalizeCountryName('Israeli'), 'Israel')
  assert.equal(normalizeCountryName('Israel'), 'Israel')

  const parsed = parseApplicantSource(readFileSync('people/form10.txt', 'utf8'))
  const html = readFileSync('dom-snapshots/spouse--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const result = matchPage({
      pageContext: 'spouse',
      inventory,
      answers: filterTranslatedText(parsed.text, 'spouse'),
      answerSheet: parsed.answerSheet?.spouse,
    })
    assert.equal(byRef(result.actions, 'ddlSpouseNatDropDownList').value, 'Israel')
    assert.equal(byRef(result.actions, 'ddlSpousePOBCountry').value, 'Israel')
  } finally {
    await browser.close()
  }
})

test('work_additional: countries-visited Yes and military service dates resolve', async () => {
  const parsed = parseApplicantSource(readFileSync('people/form10.txt', 'utf8'))
  const html = readFileSync('dom-snapshots/work_additional--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const visitedRadio = inventory.fields.find((field) => refCore(field.ref) === 'rblCOUNTRIES_VISITED_IND')
    if (visitedRadio) visitedRadio.value = ''
    const result = matchPage({
      pageContext: 'work_additional',
      inventory,
      answers: filterTranslatedText(parsed.text, 'work_additional'),
      answerSheet: parsed.answerSheet?.work_additional,
    })
    const country = result.actions.find((action) => String(action.ref || '').endsWith('ddlCOUNTRIES_VISITED'))
    const from = result.actions.find((action) => String(action.ref || '').endsWith('MILITARY_SVC_FROM'))
    const to = result.actions.find((action) => String(action.ref || '').endsWith('MILITARY_SVC_TO'))
    assert.equal(byRef(result.actions, 'rblCOUNTRIES_VISITED_IND')?.value, 'Yes')
    assert.equal(byRef(result.actions, 'rblSPECIALIZED_SKILLS_IND')?.value, 'Yes')
    assert.equal(country?.value, 'Georgia')
    assert.equal(from?.value, '01/01/1991')
    assert.ok(from?.dateParts?.month)
    assert.equal(to?.value, '01/06/1993')
    assert.ok(
      result.actions.some((action) => action.text === 'Add Another Language'),
      'second language must add a repeater row',
    )
    assert.ok(
      result.actions.some((action) => action.text === 'Add Another Visited Country'),
      'second country must add a repeater row',
    )
    assert.equal(result.nextClick, null, 'do not click Next while extra language/country rows are missing')
  } finally {
    await browser.close()
  }
})

test('work_additional: military service plans firearms specialized skills', () => {
  const parsed = parseApplicantSource(readFileSync('people/nira.txt', 'utf8'))
  const result = matchPage({
    pageContext: 'work_additional',
    inventory: {
      fields: [
        {
          ref: 'rblSPECIALIZED_SKILLS_IND',
          kind: 'radio',
          label: 'Do you have any specialized skills or training, such as firearms, explosives, nuclear, biological, or chemical experience?',
          value: '',
          required: true,
          options: [
            { text: 'Yes', value: 'Y' },
            { text: 'No', value: 'N' },
          ],
        },
        {
          ref: 'tbxSPECIALIZED_SKILLS_EXPL',
          kind: 'textarea',
          label: 'Explain',
          value: '',
          required: true,
        },
      ],
      buttons: [],
      errors: [],
    },
    answers: filterTranslatedText(parsed.text, 'work_additional'),
    answerSheet: parsed.answerSheet?.work_additional,
  })
  assert.equal(byRef(result.actions, 'rblSPECIALIZED_SKILLS_IND')?.value, 'Yes')
  assert.equal(byRef(result.actions, 'tbxSPECIALIZED_SKILLS_EXPL')?.value, 'FIREARMS MILITARY TRAINING')
})

test('work_previous: employer city does not take the school city', () => {
  const parsed = parseApplicantSource(readFileSync('people/form9.txt', 'utf8'))
  const result = matchPage({
    pageContext: 'work_previous',
    inventory: {
      fields: [
        {
          ref: 'tbxEmpCity',
          kind: 'text',
          label: 'City',
          value: '',
          required: true,
          disabled: false,
        },
        {
          ref: 'dtlPrevEduc_ctl00_tbxSchoolCity',
          kind: 'text',
          label: 'City',
          row: 1,
          value: '',
          required: true,
          disabled: false,
        },
      ],
      buttons: [{ text: 'Next: Work/Education: Additional' }],
      errors: [],
    },
    answers: filterTranslatedText(parsed.text, 'work_previous'),
    answerSheet: parsed.answerSheet?.work_previous,
  })
  assert.equal(byRef(result.actions, 'tbxEmpCity')?.value, 'Hod HaSharon')
  assert.equal(byRef(result.actions, 'tbxEmpCity')?.label, 'Employer City')
  assert.equal(
    result.actions.find((action) => String(action.ref || '').endsWith('tbxSchoolCity'))?.value,
    'Modiin',
  )
})

test('work_previous: employer name drops the Ltd. period CEAC rejects', () => {
  const parsed = parseApplicantSource(readFileSync('people/form9.txt', 'utf8'))
  const result = matchPage({
    pageContext: 'work_previous',
    inventory: {
      fields: [
        {
          ref: 'tbxEmpName',
          kind: 'text',
          label: 'Employer Name',
          value: 'ELBIT SYSTEMS LTD.',
          required: true,
          disabled: false,
        },
      ],
      buttons: [{ text: 'Next' }],
      errors: [],
    },
    answers: filterTranslatedText(parsed.text, 'work_previous'),
    answerSheet: parsed.answerSheet?.work_previous,
  })
  assert.equal(byRef(result.actions, 'tbxEmpName')?.value, 'Elbit Systems Ltd')
})

test('work_previous: Does Not Apply state/ZIP and school dates resolve', async () => {
  const parsed = parseApplicantSource(readFileSync('people/form9.txt', 'utf8'))
  const html = readFileSync('dom-snapshots/work_previous--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const result = matchPage({
      pageContext: 'work_previous',
      inventory,
      answers: filterTranslatedText(parsed.text, 'work_previous'),
      answerSheet: parsed.answerSheet?.work_previous,
    })
    assert.equal(
      result.actions.find((action) => String(action.ref || '').endsWith('cbxEDUC_INST_ADDR_STATE_NA'))?.type,
      'check',
    )
    assert.equal(
      result.actions.find((action) => String(action.ref || '').endsWith('cbxEDUC_INST_POSTAL_CD_NA'))?.type,
      'check',
    )
    const from = result.actions.find((action) => String(action.ref || '').endsWith('SchoolFrom'))
    const to = result.actions.find((action) => String(action.ref || '').endsWith('SchoolTo'))
    assert.equal(from?.value, '01/09/2018')
    assert.equal(to?.value, '01/09/2021')
  } finally {
    await browser.close()
  }
})

test('phone fill values are digits only', () => {
  const result = matchPage({
    pageContext: 'address',
    inventory: {
      fields: [
        {
          ref: 'tbxAPP_HOME_TEL',
          kind: 'text',
          label: 'Primary Phone Number',
          value: '',
          required: true,
        },
      ],
      buttons: [],
      errors: [],
    },
    answers: 'Primary Phone Number: +972 538055645',
  })
  assert.equal(result.actions[0]?.value, '972538055645')
})

test('address: mailing-same radio is answered and N/A phones become checkboxes', async () => {
  const { result } = await matchSnapshot('address--expanded.html', 'address')

  assert.deepEqual(byRef(result.actions, 'rblMailingAddrSame'), {
    type: 'radio',
    label: 'Is your Mailing Address the same as your Home Address?',
    value: 'Yes',
    ref: 'rblMailingAddrSame',
  })
  assert.equal(byRef(result.actions, 'tbxAPP_ADDR_LN1').value, 'HaAgur 4, Apartment 23')
  assert.equal(byRef(result.actions, 'cbexAPP_MOBILE_TEL_NA').type, 'check')
  assert.equal(byRef(result.actions, 'cbexAPP_BUS_TEL_NA').type, 'check')
  assert.equal(byRef(result.actions, 'tbxAPP_MOBILE_TEL'), undefined)
})

test('address: no social media in the source selects NONE', () => {
  const answers = [
    'SOCIAL MEDIA',
    'Have you used social media platforms in the last 5 years? No',
    'None',
  ].join('\n')
  assert.equal(sourceUsedSocialMedia(answers), false)
  const result = matchPage({
    pageContext: 'address',
    inventory: {
      fields: [
        {
          ref: 'ddlSocialMedia',
          kind: 'select',
          label: 'Social Media Provider/Platform',
          value: '- SELECT ONE -',
          required: true,
          options: ['- SELECT ONE -', 'FACEBOOK', 'INSTAGRAM', 'NONE'],
        },
      ],
      buttons: [],
      errors: [],
    },
    answers,
  })
  assert.equal(byRef(result.actions, 'ddlSocialMedia')?.value, 'NONE')
  assert.equal(
    result.unresolvedRequired.some((field) => field.ref === 'ddlSocialMedia'),
    false,
  )
})

test('travel stay fields ignore the payer company address in Israel', () => {
  const answers = [
    '🟦 TRAVEL INFORMATION',
    'Arrival City: New York',
    '**PERSON/ENTITY PAYING FOR TRIP**',
    'Who is paying for the trip? Other Company/Organization',
    'Street Address (Line 1): Kanfei Nesharim 5',
    'City: Jerusalem',
    'State/Province: DOES NOT APPLY',
    'Postal Zone/ZIP Code: 9546412',
    'Country/Region: Israel',
  ].join('\n')
  const result = matchPage({
    pageContext: 'travel',
    inventory: {
      fields: [
        { ref: 'tbxStreetAddress1', kind: 'text', label: 'Street Address (Line 1)', value: '', required: true },
        { ref: 'tbxCity', kind: 'text', label: 'City', value: '', required: true },
        { ref: 'ddlTravelState', kind: 'select', label: 'State', value: '- SELECT ONE -', required: true },
        { ref: 'tbZIPCode', kind: 'text', label: 'ZIP Code', value: '', required: true },
      ],
      buttons: [],
    },
    answers,
  })
  assert.equal(result.actions.find((action) => action.ref === 'tbxStreetAddress1'), undefined)
  assert.equal(result.actions.find((action) => action.ref === 'tbxCity'), undefined)
  assert.equal(result.actions.find((action) => action.ref === 'tbZIPCode'), undefined)
})

test('travel stay address stays the U.S. hotel when a payer address is also listed', () => {
  const answers = [
    'Address Where You Will Stay in the U.S.:',
    'Street Address (Line 1): Hotels',
    'City: New York',
    'State: NY',
    'ZIP Code: 00000',
    'PERSON/ENTITY PAYING FOR TRIP',
    'Street Address (Line 1): Kanfei Nesharim 5',
    'City: Jerusalem',
    'Postal Zone/ZIP Code: 9546412',
  ].join('\n')
  const result = matchPage({
    pageContext: 'travel',
    inventory: {
      fields: [
        { ref: 'tbxStreetAddress1', kind: 'text', label: 'Street Address (Line 1)', value: '', required: true },
        { ref: 'tbxCity', kind: 'text', label: 'City', value: '', required: true },
        { ref: 'tbZIPCode', kind: 'text', label: 'ZIP Code', value: '', required: true },
      ],
      buttons: [],
    },
    answers,
  })
  assert.equal(result.actions.find((action) => action.ref === 'tbxStreetAddress1')?.value, 'Hotels')
  assert.equal(result.actions.find((action) => action.ref === 'tbxCity')?.value, 'New York')
  assert.equal(result.actions.find((action) => action.ref === 'tbZIPCode')?.value, '00000')
})

test('travel: B1/B2 purpose, stay address and payer resolve without the LLM', async () => {
  const parsed = parseApplicantSource(readFileSync('people/form10.txt', 'utf8'))
  const html = readFileSync('dom-snapshots/travel--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const result = matchPage({
      pageContext: 'travel',
      inventory,
      answers: filterTranslatedText(parsed.text, 'travel'),
      answerSheet: parsed.answerSheet?.travel,
    })
    const purpose = result.actions.find((action) => refCore(action.ref) === 'ddlPurposeOfTrip')
    const payer = result.actions.find((action) => action.ref === 'ddlWhoIsPaying')
    const street = result.actions.find((action) => action.ref === 'tbxStreetAddress1')
    const city = result.actions.find((action) => action.ref === 'tbxCity')
    const zip = result.actions.find((action) => action.ref === 'tbZIPCode')
    assert.equal(purpose?.value, 'TEMP. BUSINESS OR PLEASURE VISITOR (B)')
    assert.equal(payer?.value, 'Self')
    assert.equal(street?.value, 'Hotels')
    assert.equal(city?.value, 'New York')
    assert.equal(zip?.value, '00000')
  } finally {
    await browser.close()
  }
})

test('travel: Specify B1/B2 maps after the purpose postback', () => {
  const result = matchPage({
    pageContext: 'travel',
    inventory: {
      fields: [
        {
          ref: 'ddlOtherPurpose',
          kind: 'select',
          label: 'Specify',
          value: 'PLEASE SELECT',
          required: true,
          options: [
            { text: 'PLEASE SELECT', value: '' },
            { text: 'BUSINESS OR TOURISM (TEMPORARY VISITOR) (B1/B2)', value: 'B1-B2' },
          ],
        },
        {
          ref: 'TRAVEL_DTE',
          kind: 'date',
          label: 'Intended Date of Arrival',
          value: '',
          required: true,
        },
        {
          ref: 'tbxTRAVEL_LOS',
          kind: 'text',
          label: 'Intended Length of Stay in U.S.',
          value: '',
          required: true,
        },
        {
          ref: 'ddlTRAVEL_LOS_CD',
          kind: 'select',
          label: 'Intended Length of Stay in U.S.',
          value: '-SELECT ONE-',
          required: true,
          options: [
            { text: '-SELECT ONE-', value: '' },
            { text: 'Week(s)', value: 'W' },
            { text: 'Month(s)', value: 'M' },
          ],
        },
      ],
      buttons: [{ text: 'Next: Travel Companions' }],
      errors: [],
    },
    answers: '',
    answerSheet: {
      visa_class: 'B1/B2',
      intended_date_of_arrival: '2026-11-20',
      intended_length_of_stay: '3 weeks',
    },
  })
  assert.equal(byRef(result.actions, 'ddlOtherPurpose').value, 'BUSINESS OR TOURISM (TEMPORARY VISITOR) (B1/B2)')
  assert.equal(byRef(result.actions, 'TRAVEL_DTE').value, '20/11/2026')
  assert.equal(byRef(result.actions, 'tbxTRAVEL_LOS').value, '3')
  assert.equal(byRef(result.actions, 'ddlTRAVEL_LOS_CD').value, 'Week(s)')
  assert.equal(result.nextClick?.text, 'Next: Travel Companions')
})

test('travel: does not click Next until intended stay exists on the No-plans path', () => {
  const result = matchPage({
    pageContext: 'travel',
    inventory: {
      fields: [
        {
          ref: 'rblSpecificTravel',
          kind: 'radio',
          label: 'Have you made specific travel plans?',
          value: '',
          required: true,
          options: ['Yes', 'No'],
        },
        {
          ref: 'ddlWhoIsPaying',
          kind: 'select',
          label: 'Person/Entity Paying for Your Trip',
          value: '-SELECT ONE-',
          required: true,
          options: [
            { text: '-SELECT ONE-', value: '' },
            { text: 'Self', value: 'S' },
          ],
        },
      ],
      buttons: [{ text: 'Next: Travel Companions' }],
      errors: [],
    },
    answers: 'Have you made specific travel plans? No\nIntended Length of Stay: 3 weeks',
    answerSheet: {
      specific_travel_plans: false,
      intended_length_of_stay: '3 weeks',
      trip_payer: 'Self',
    },
  })
  assert.equal(byRef(result.actions, 'rblSpecificTravel')?.value, 'No')
  assert.equal(result.nextClick, null)
})

test('revealed stay-length fields are filled even when CEAC has not marked them required', () => {
  const added = [
    {
      ref: 'tbxTRAVEL_LOS',
      kind: 'text',
      label: 'Intended Length of Stay in U.S.',
      value: '',
      required: false,
    },
    {
      ref: 'ddlTRAVEL_LOS_CD',
      kind: 'select',
      label: 'Intended Length of Stay in U.S.',
      value: '-SELECT ONE-',
      required: false,
      options: [
        { text: '-SELECT ONE-', value: '' },
        { text: 'Week(s)', value: 'W' },
      ],
    },
    {
      ref: 'tbxOptionalNote',
      kind: 'text',
      label: 'Notes',
      value: '',
      required: false,
    },
  ]
  const revealed = revealedFieldsToFill(added, [])
  assert.deepEqual(revealed.map((field) => field.ref), [
    'tbxTRAVEL_LOS',
    'ddlTRAVEL_LOS_CD',
    'tbxOptionalNote',
  ])
  assert.equal(added.filter(isIntendedStayLengthField).length, 2)

  const result = matchPage({
    pageContext: 'travel',
    inventory: { fields: added, buttons: [{ text: 'Next: Travel Companions' }], errors: [] },
    answers: '',
    answerSheet: { intended_length_of_stay: '3 weeks' },
  })
  assert.equal(byRef(result.actions, 'tbxTRAVEL_LOS').value, '3')
  assert.equal(byRef(result.actions, 'ddlTRAVEL_LOS_CD').value, 'Week(s)')
})

test('travel: stay unit still maps when the inventory ref is not canonical', () => {
  const result = matchPage({
    pageContext: 'travel',
    inventory: {
      fields: [
        {
          ref: 'ddlLengthOfStay',
          kind: 'select',
          label: 'Intended Length of Stay in U.S.',
          value: '-SELECT ONE-',
          required: true,
          options: [
            { text: '-SELECT ONE-', value: '' },
            { text: 'Week(s)', value: 'W' },
          ],
        },
      ],
      buttons: [],
      errors: [],
    },
    answers: 'Intended Length of Stay in U.S.: 3 weeks',
    answerSheet: { intended_length_of_stay: '3 weeks' },
  })
  assert.equal(result.actions[0].type, 'selectOption')
  assert.equal(result.actions[0].value, 'Week(s)')
})

test('an answer sheet fills gaps the prose does not cover', async () => {
  const html = readFileSync('dom-snapshots/personal1--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)

    const result = matchPage({
      pageContext: 'personal1',
      inventory,
      answers: 'Surname: MISHEL',
      answerSheet: { given_names: 'ODETTE', 'city of birth': 'Bucharest' },
    })

    assert.equal(byRef(result.actions, 'tbxAPP_SURNAME').value, 'MISHEL')
    assert.equal(byRef(result.actions, 'tbxAPP_GIVEN_NAME').value, 'ODETTE')
    assert.equal(byRef(result.actions, 'tbxAPP_POB_CITY').value, 'Bucharest')
  } finally {
    await browser.close()
  }
})

test('ISO dates from the answer sheet are filled unambiguously', async () => {
  const html = readFileSync('dom-snapshots/passport--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)

    const result = matchPage({
      pageContext: 'passport',
      inventory,
      answers: '',
      answerSheet: { issuance_date: '2019-04-03', expiration_date: '2029-04-02' },
    })

    // 2019-04-03 is 3 April, never 4 March: the ISO input removes the guess that
    // a "03/04/2019" source would have forced.
    const issued = byRef(result.actions, 'PPT_ISSUED_DTE')
    assert.equal(issued.value, '03/04/2019')
    assert.deepEqual(issued.dateParts, {
      day: 'ddlPPT_ISSUED_DTEDay',
      month: 'ddlPPT_ISSUED_DTEMonth',
      year: 'tbxPPT_ISSUEDYear',
    })

    // The expiry year box drops the "_DTE" the other two controls carry, which is
    // exactly the kind of detail dateParts exists to stop callers guessing.
    const expires = byRef(result.actions, 'PPT_EXPIRE_DTE')
    assert.equal(expires.value, '02/04/2029')
    assert.equal(expires.dateParts.year, 'tbxPPT_EXPIREYear')
  } finally {
    await browser.close()
  }
})

// executeAction decides a value is a date by looking at the action's label, so a
// date group whose caption does not read like one is filled as plain text into
// whatever [id$=ref] resolves to — in practice the field's validator span, which
// is invisible, so the click waits out its timeout. This happened live with
// "TRAVEL DTE", the arrival date shown when the applicant has no fixed plans.
test('every date group is captioned so it is recognized as a date', async () => {
  const dateRouting = /date|attendance\s+(?:from|to)|service\s+(?:from|to)/i
  const browser = await chromium.launch({ headless: true })
  try {
    for (const snapshot of Object.values(REGISTRY_SNAPSHOTS)) {
      const page = await browser.newPage()
      await page.setContent(readFileSync(`dom-snapshots/${snapshot}`, 'utf8'), {
        waitUntil: 'domcontentloaded',
      })
      const inventory = await extractPageInventory(page)

      for (const field of inventory.fields.filter((f) => f.kind === 'date')) {
        assert.match(field.label, dateRouting, `${snapshot}: "${field.ref}" reads "${field.label}"`)
        assert.ok(field.dateParts, `${snapshot}: "${field.ref}" has no dateParts`)
      }
      await page.close()
    }
  } finally {
    await browser.close()
  }
})

test('matcher only claims page contexts it has been verified against', () => {
  assert.deepEqual(
    [...MATCHER_PAGES].sort(),
    [
      'address',
      'companions',
      'contact',
      'family',
      'passport',
      'personal1',
      'personal2',
      'prev_travel',
      'security',
      'spouse',
      'travel',
      'work_additional',
      'work_edu',
      'work_present',
      'work_previous',
    ],
  )

  // Every registered page must be one the matcher runs on, or its entries are
  // dead weight that nothing will ever consult.
  for (const page of Object.keys(DS160_FIELDS)) {
    assert.ok(MATCHER_PAGES.has(page), `registry page "${page}" is not a matcher page`)
  }
})

// The registry is only worth trusting if its refs are real. A typo here would
// otherwise surface as a field the matcher silently never fills.
const REGISTRY_SNAPSHOTS = {
  personal1: 'personal1--expanded.html',
  personal2: 'personal2--expanded.html',
  address:   'address_phone--expanded.html',
  passport:  'passport--expanded.html',
  contact:   'us_point_of_contact--expanded.html',
  family:    'family--expanded.html',
  spouse:    'spouse--expanded.html',
  travel:    'travel--expanded.html',
  companions: 'companions--expanded.html',
  prev_travel: 'prev_travel--expanded.html',
  work_present: 'work-present--expanded.html',
  work_previous: 'work_previous--expanded.html',
  work_additional: 'work_additional--expanded.html',
}

for (const [pageContext, snapshot] of Object.entries(REGISTRY_SNAPSHOTS)) {
  test(`${pageContext}: every registry ref exists in the page inventory`, async () => {
    const html = readFileSync(`dom-snapshots/${snapshot}`, 'utf8')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'domcontentloaded' })
      const inventory = await extractPageInventory(page)
      const present = new Set(inventory.fields.map((field) => refCore(field.ref)))

      for (const [id, entry] of Object.entries(DS160_FIELDS[pageContext])) {
        if (entry.afterPostback) continue
        assert.ok(present.has(entry.ref), `${pageContext}.${id} → missing ref "${entry.ref}"`)
      }
      for (const [id, ref] of Object.entries(DS160_UNKNOWN_CHECKBOXES[pageContext] || {})) {
        assert.ok(present.has(ref), `${pageContext}.${id} → missing checkbox "${ref}"`)
      }
    } finally {
      await browser.close()
    }
  })
}
