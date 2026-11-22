import assert from 'node:assert/strict'
import test from 'node:test'

import {
  lockApplicantNamesFromPortal,
  stripParentheticalAliasesFromPersonNames,
} from '../lib/personNameFormatting.js'

test('removes parenthetical aliases from English and native person names', () => {
  const translated = [
    'Surname: LUSTMAN (SOKOLOVA)',
    'Given Name: TETIANA',
    'Full Name in Native Alphabet: טטיאנה לוסטמן (סוקולובה)',
    'Former Spouse Surname: COHEN (LEVY)',
  ].join('\n')

  assert.equal(
    stripParentheticalAliasesFromPersonNames(translated),
    [
      'Surname: LUSTMAN',
      'Given Name: TETIANA',
      'Full Name in Native Alphabet: טטיאנה לוסטמן',
      'Former Spouse Surname: COHEN',
    ].join('\n'),
  )
})

test('copies the portal applicant name over a nationality word the model appended', () => {
  const translated = [
    'Surname: YIFRAH',
    'Given Name: Netanel Israel',
    'Full Name in Native Alphabet: נתנאל ישראל יפרח',
    'Spouse Surname: COHEN',
    'Spouse Given Name: MAYA',
    'Father’s Surname: YIFRAH',
  ].join('\n')

  assert.equal(
    lockApplicantNamesFromPortal(translated, {
      surname: 'YIFRAH',
      givenName: 'NETANEL',
      nativeName: 'נתנאל יפרח',
    }),
    [
      'Surname: YIFRAH',
      'Given Name: NETANEL',
      'Full Name in Native Alphabet: נתנאל יפרח',
      'Spouse Surname: COHEN',
      'Spouse Given Name: MAYA',
      'Father’s Surname: YIFRAH',
    ].join('\n'),
  )
})

test('preserves parentheses in non-person fields', () => {
  const translated = [
    'Organization Name: Example Holdings (USA)',
    'Phone Number: +1 (646) 207-8814',
    'Describe Your Duties: Quality control (night shift)',
  ].join('\n')

  assert.equal(stripParentheticalAliasesFromPersonNames(translated), translated)
})
