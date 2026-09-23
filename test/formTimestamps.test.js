import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCreatedAt, resolveUpdatedAt } from '../lib/formTimestamps.js'

test('created time stays on the original value', () => {
  assert.equal(
    resolveCreatedAt(
      { createdAt: '2026-01-02T00:00:00.000Z' },
      { createdAt: '2026-09-01T00:00:00.000Z', data: { formStartedDate: '2026-05-09' } },
      '2026-09-23T08:00:00.000Z',
    ),
    '2026-01-02T00:00:00.000Z',
  )
})

test('old forms use the stored start date when created time was never saved', () => {
  assert.equal(
    resolveCreatedAt({}, { data: { formStartedDate: '2026-05-09' } }, null),
    '2026-05-09',
  )
})

test('a brand-new form gets the save time', () => {
  assert.equal(
    resolveCreatedAt({}, {}, '2026-09-23T08:00:00.000Z'),
    '2026-09-23T08:00:00.000Z',
  )
})

test('updated time prefers this save, then the blob upload time', () => {
  assert.equal(
    resolveUpdatedAt(
      { updatedAt: '2026-08-01T00:00:00.000Z' },
      { now: '2026-09-23T08:00:00.000Z', uploadedAt: '2026-09-01T00:00:00.000Z' },
    ),
    '2026-09-23T08:00:00.000Z',
  )
  assert.equal(
    resolveUpdatedAt({}, { uploadedAt: '2026-09-01T00:00:00.000Z' }),
    '2026-09-01T00:00:00.000Z',
  )
})
