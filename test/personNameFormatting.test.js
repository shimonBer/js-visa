import assert from 'node:assert/strict'
import test from 'node:test'

import { stripParentheticalAliasesFromPersonNames } from '../lib/personNameFormatting.js'

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

test('preserves parentheses in non-person fields', () => {
  const translated = [
    'Organization Name: Example Holdings (USA)',
    'Phone Number: +1 (646) 207-8814',
    'Describe Your Duties: Quality control (night shift)',
  ].join('\n')

  assert.equal(stripParentheticalAliasesFromPersonNames(translated), translated)
})
