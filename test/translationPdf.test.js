import assert from 'node:assert/strict'
import test from 'node:test'

import { translationPdfKey } from '../lib/translationPdf.js'

test('translation PDF uses one stable key per form', () => {
  const id = 'a8255c90-fcf2-4cf2-a23c-1f7ef39595fd'
  assert.equal(translationPdfKey(id), `${id}/translation.pdf`)
  assert.equal(translationPdfKey(`  ${id}  `), `${id}/translation.pdf`)
})

test('translation PDF key rejects ids that cannot be an S3 path', () => {
  assert.equal(translationPdfKey(''), '')
  assert.equal(translationPdfKey('שם עברי'), '')
  assert.equal(translationPdfKey('../secret'), '')
})
