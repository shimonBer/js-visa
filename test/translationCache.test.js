import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeStoredTranslation } from '../src/lib/translationCache.js'

test('normalizeStoredTranslation keeps fingerprint and text only', () => {
  assert.equal(normalizeStoredTranslation(null), null)
  assert.equal(normalizeStoredTranslation({ fingerprint: 'abc' }), null)
  assert.deepEqual(
    normalizeStoredTranslation({
      fingerprint: 'abc',
      translated: 'Hello',
      attachmentLabels: ['passportScan: p.jpg'],
      savedAt: '2026-09-20T00:00:00.000Z',
      pdfBase64: 'should-not-be-kept',
    }),
    {
      fingerprint: 'abc',
      translated: 'Hello',
      attachmentLabels: ['passportScan: p.jpg'],
      savedAt: '2026-09-20T00:00:00.000Z',
    },
  )
})
