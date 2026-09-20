import assert from 'node:assert/strict'
import test from 'node:test'

import { translatedDownloadFileName } from '../lib/translatedFileName.js'

test('uses english first and last name', () => {
  assert.equal(
    translatedDownloadFileName({ firstName: 'NIRA', lastName: 'BITON' }),
    'nira_biton.txt',
  )
})

test('slugs spaces and punctuation', () => {
  assert.equal(
    translatedDownloadFileName({ firstName: 'Liat Gallia', lastName: "O'Connor" }),
    'liat_gallia_o_connor.txt',
  )
})

test('falls back to translated text when hebrew names do not slug', () => {
  const translatedText = [
    'Surname: BITON',
    'Given Name: NIRA',
  ].join('\n')
  assert.equal(
    translatedDownloadFileName({
      firstName: 'נירה',
      lastName: 'ביטון',
      translatedText,
    }),
    'nira_biton.txt',
  )
})

test('falls back to translated.txt when nothing usable exists', () => {
  assert.equal(translatedDownloadFileName({}), 'translated.txt')
})
