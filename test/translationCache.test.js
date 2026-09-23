import assert from 'node:assert/strict'
import test from 'node:test'

class PolyFile {
  constructor(parts, name, opts = {}) {
    this.name = name
    this.size = parts.reduce((total, part) => total + String(part).length, 0)
    this.lastModified = opts.lastModified ?? Date.now()
    this.type = opts.type || ''
  }
}

globalThis.File = PolyFile

import {
  buildTranslationFingerprint,
  fileSignature,
  normalizeStoredTranslation,
} from '../src/lib/translationCache.js'

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

test('translation fingerprint ignores object key order', () => {
  const left = buildTranslationFingerprint({ firstName: 'A', lastName: 'B' })
  const right = buildTranslationFingerprint({ lastName: 'B', firstName: 'A' })
  assert.equal(left, right)
})

test('reloaded scan reuses the saved translation fingerprint', () => {
  const picked = new File(['abcd'], 'my-passport.jpg', { lastModified: 1000 })
  const s3 = [{ field: 'passportScan', key: 'uuid/passportScan.jpg' }]
  const saved = buildTranslationFingerprint(
    { firstName: 'A', passportScan: picked },
    s3,
    { passportScan: fileSignature(picked) },
  )
  const restored = new File(['abcd'], 'passportScan.jpg', { lastModified: Date.now() })
  const again = buildTranslationFingerprint({ firstName: 'A', passportScan: restored }, s3, {})
  assert.equal(saved, again)
})

test('a newly picked file changes the translation fingerprint', () => {
  const s3 = [{ field: 'passportScan', key: 'uuid/passportScan.jpg' }]
  const before = buildTranslationFingerprint({ firstName: 'A' }, s3, {})
  const picked = new File(['zzzz'], 'other.jpg', { lastModified: 5 })
  const after = buildTranslationFingerprint({ firstName: 'A', passportScan: picked }, s3, {})
  assert.notEqual(before, after)
})
