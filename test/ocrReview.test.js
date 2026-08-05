import assert from 'node:assert/strict'
import test from 'node:test'

import { compareOcrPasses, runTwoPassOcr } from '../src/lib/ocrReview.js'

const passportFields = [
  { key: 'passportNumber', label: 'Passport number', required: true, format: 'passport' },
  { key: 'issueDate', label: 'Issue date', required: true, format: 'date' },
  { key: 'expirationDate', label: 'Expiration date', required: true, format: 'date', after: 'issueDate' },
]

test('auto-approves matching valid OCR passes', () => {
  const value = {
    passportNumber: 'AB-123456',
    issueDate: '2024-01-01',
    expirationDate: '2034-01-01',
  }
  const comparison = compareOcrPasses(value, { ...value, passportNumber: 'AB123456' }, passportFields)

  assert.equal(comparison.needsReview, false)
  assert.equal(comparison.reasons.length, 0)
})

test('requires review when OCR passes disagree', () => {
  const comparison = compareOcrPasses(
    { passportNumber: 'AB123456', issueDate: '2024-01-01', expirationDate: '2034-01-01' },
    { passportNumber: 'AB123458', issueDate: '2024-01-01', expirationDate: '2034-01-01' },
    passportFields,
  )

  assert.equal(comparison.needsReview, true)
  assert.match(comparison.reasons.join('\n'), /OCR passes disagree/)
})

test('requires review for invalid dates and expiration ordering', () => {
  const value = {
    passportNumber: 'AB123456',
    issueDate: '2034-01-01',
    expirationDate: '2024-01-01',
  }
  const comparison = compareOcrPasses(value, value, passportFields)

  assert.equal(comparison.needsReview, true)
  assert.match(comparison.reasons.join('\n'), /must be after/)
})

test('retains a successful pass when the other OCR request fails', async () => {
  let calls = 0
  const extract = async () => {
    calls += 1
    if (calls === 1) throw new Error('temporary OCR failure')
    return { passportNumber: 'AB123456' }
  }

  const result = await runTwoPassOcr(extract, {})

  assert.deepEqual(result.first, {})
  assert.equal(result.second.passportNumber, 'AB123456')
  assert.match(result.passErrors[0], /temporary OCR failure/)
})
