import assert from 'node:assert/strict'
import test from 'node:test'

import { filterTranslatedText } from '../autofill/agent.js'
import { detectPageContext, detectPageContextFromUrl } from '../autofill/detect-page-context.js'
import {
  applyDeceasedSpouseToTranslatedText,
  parseDeceasedSpouseSection,
} from '../lib/deceasedSpouse.js'

const DROPPED = [
  'Sex: Female',
  'Marital Status: Single',
  '',
  '🟦 SPOUSE INFORMATION',
  '',
  'Are you currently married? No',
  '',
  '🟦 PREVIOUS SPOUSES',
  '',
  'Have you ever been married before? No',
  '',
  '🟦 WORK / EDUCATION / TRAINING',
].join('\n')

test('widowed intake writes the deceased spouse into the translated form', () => {
  const translated = applyDeceasedSpouseToTranslatedText(DROPPED, {
    maritalStatus: 'אלמן',
    deceasedSpouseName: 'נוטושו יום טוב מסיקה',
    deceasedSpouseBirthDate: '1964-04-18',
    deceasedSpouseCitizenship: 'ישראלית',
    deceasedSpouseBirthCityCountry: 'באר יעקוב',
  })

  assert.match(translated, /^Marital Status: Widowed$/m)
  assert.match(translated, /Are you currently married\? No/)
  assert.match(translated, /Have you ever been married before\? No/)
  const parsed = parseDeceasedSpouseSection(translated)
  assert.equal(parsed.surname, 'MSIKA')
  assert.equal(parsed.givenName, 'NOTOSHO YOM TOV')
  assert.equal(parsed.birthDate, '18/04/1964')
  assert.equal(parsed.nationality, 'Israel')
  assert.equal(parsed.city, 'Beer Yaakov')
  assert.equal(parsed.country, 'Israel')
  assert.doesNotMatch(translated, /[\u0590-\u05FF]/)
})

test('a complete Latin deceased-spouse section is kept', () => {
  const already = [
    'Marital Status: Widowed',
    '🟦 DECEASED SPOUSE',
    'Deceased Spouse Surname: MESIKA',
    'Deceased Spouse Given Name: NOTOSHO YOM TOV',
    'Deceased Spouse Date of Birth: 18/04/1964',
    'Deceased Spouse Nationality: Israel',
    'Deceased Spouse City of Birth: Beer Yaakov',
    'Deceased Spouse Country of Birth: Israel',
    '🟦 PREVIOUS SPOUSES',
    'Have you ever been married before? No',
  ].join('\n')

  const translated = applyDeceasedSpouseToTranslatedText(already, {
    maritalStatus: 'אלמן',
    deceasedSpouseName: 'נוטושו יום טוב מסיקה',
    deceasedSpouseBirthDate: '1964-04-18',
    deceasedSpouseCitizenship: 'ישראלית',
    deceasedSpouseBirthCityCountry: 'באר יעקוב',
  })

  assert.equal(parseDeceasedSpouseSection(translated).surname, 'MESIKA')
  assert.equal(translated.match(/🟦 DECEASED SPOUSE/g).length, 1)
})

test('other marital statuses are left unchanged', () => {
  const married = 'Marital Status: Married\n🟦 SPOUSE INFORMATION\nAre you currently married? Yes\n'
  assert.equal(
    applyDeceasedSpouseToTranslatedText(married, { maritalStatus: 'נשוי', deceasedSpouseName: 'מישהו' }),
    married,
  )
})

test('deceased spouse page reads only that section', () => {
  const translated = applyDeceasedSpouseToTranslatedText(DROPPED, {
    maritalStatus: 'Widowed',
    deceasedSpouseName: 'YOM TOV MESIKA',
    deceasedSpouseBirthDate: '18/04/1964',
    deceasedSpouseCitizenship: 'Israel',
    deceasedSpouseBirthCityCountry: 'Beer Yaakov',
  })
  const section = filterTranslatedText(translated, 'deceased_spouse')
  assert.match(section, /Deceased Spouse Surname: MESIKA/)
  assert.doesNotMatch(section, /Have you ever been married before/)
  assert.equal(
    detectPageContextFromUrl(
      'https://ceac.state.gov/GenNIV/General/complete/complete_family4.aspx?node=DeceasedSpouse',
    ),
    'deceased_spouse',
  )
  assert.equal(
    detectPageContext({
      href: 'https://ceac.state.gov/GenNIV/General/complete/complete_family.aspx?node=Family',
      heading: 'Family Information: Deceased Spouse',
    }),
    'deceased_spouse',
  )
})
