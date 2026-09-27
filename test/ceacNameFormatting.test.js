import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ceacNameNeedsRewrite,
  isCeacNameField,
  normalizeCeacNameFieldsInSourceData,
  normalizeCeacNameFillValue,
  normalizeCeacNamesInTranslatedText,
  sanitizeCeacName,
} from '../lib/ceacNameFormatting.js'

test('employer names drop periods and other illegal punctuation', () => {
  assert.equal(sanitizeCeacName('Elbit Systems Ltd.'), 'Elbit Systems Ltd')
  assert.equal(sanitizeCeacName('ELBIT SYSTEMS LTD.'), 'ELBIT SYSTEMS LTD')
  assert.equal(sanitizeCeacName('Eli Cohen Agriculture Ltd.'), 'Eli Cohen Agriculture Ltd')
  assert.equal(sanitizeCeacName('Example Holdings (USA)'), 'Example Holdings USA')
  assert.equal(sanitizeCeacName("SACK'S Fashion"), "SACK'S Fashion")
  assert.equal(sanitizeCeacName('AT&T'), 'AT&T')
  assert.equal(sanitizeCeacName('Ben-Gurion University'), 'Ben-Gurion University')
  assert.equal(sanitizeCeacName('N/A'), 'N/A')
  assert.equal(sanitizeCeacName('DO NOT KNOW'), 'DO NOT KNOW')
})

test('rewrite detection catches a trailing Ltd. period', () => {
  assert.equal(ceacNameNeedsRewrite('ELBIT SYSTEMS LTD.'), true)
  assert.equal(ceacNameNeedsRewrite('ELBIT SYSTEMS LTD'), false)
  assert.equal(ceacNameNeedsRewrite('DO NOT KNOW'), false)
})

test('field detection covers employer, school, org, and job title', () => {
  assert.equal(isCeacNameField({ label: 'Employer Name' }), true)
  assert.equal(isCeacNameField({ label: 'Present Employer or School Name' }), true)
  assert.equal(isCeacNameField({ ref: 'tbxEmpName' }), true)
  assert.equal(isCeacNameField({ key: 'employerName' }), true)
  assert.equal(isCeacNameField({ label: 'Employer Address' }), false)
  assert.equal(isCeacNameField({ label: 'Employer Phone Number' }), false)
  assert.equal(isCeacNameField({ label: 'Surnames' }), false)
})

test('translated employer lines lose the Ltd. period', () => {
  const translated = [
    'Employer Name: Elbit Systems Ltd.',
    'Present Employer or School Name: Kapit',
    'School / Institution Name: Ort Ironi D',
    'Organization Name: HOTELS',
    'Employer Address: Road 4, Ta\'as Sha\'ar Si',
  ].join('\n')

  assert.equal(
    normalizeCeacNamesInTranslatedText(translated),
    [
      'Employer Name: Elbit Systems Ltd',
      'Present Employer or School Name: Kapit',
      'School / Institution Name: Ort Ironi D',
      'Organization Name: HOTELS',
      'Employer Address: Road 4, Ta\'as Sha\'ar Si',
    ].join('\n'),
  )
})

test('source JSON employer names are sanitized', () => {
  const normalized = normalizeCeacNameFieldsInSourceData({
    employerName: 'Kapit',
    previousEmployments: [{ employerName: 'Elbit Systems Ltd.', jobTitle: 'Facilities Operator' }],
    educationRecords: [{ institutionName: 'Ort Ironi D.' }],
  })
  assert.equal(normalized.previousEmployments[0].employerName, 'Elbit Systems Ltd')
  assert.equal(normalized.educationRecords[0].institutionName, 'Ort Ironi D')
})

test('fill values are sanitized only for CEAC name fields', () => {
  assert.equal(
    normalizeCeacNameFillValue('Elbit Systems Ltd.', { label: 'Employer Name' }),
    'Elbit Systems Ltd',
  )
  assert.equal(
    normalizeCeacNameFillValue('Road 4, Ta\'as Sha\'ar Si', { label: 'Street Address (Line 1)' }),
    'Road 4, Ta\'as Sha\'ar Si',
  )
})
