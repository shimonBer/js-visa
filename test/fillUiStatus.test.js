import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { classifyFillResult, extractFillReason } from '../scripts/fill-ui/status.js'
import { buildFillEmail, shouldEmailStatus } from '../scripts/fill-ui/email.js'

test('already-submitted retrieve dialog is success, not a retryable failure', () => {
  const result = classifyFillResult({
    code: 0,
    logText: 'APPLICATION_ALREADY_SUBMITTED — CEAC says this application is already submitted.\n✅  APPLICATION SUBMITTED — already submitted at CEAC\nApplication ID for later retrieve: AA00FSVJWN',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.appId, 'AA00FSVJWN')
})

test('submitted log is success even if later steps warn', () => {
  const result = classifyFillResult({
    code: 0,
    logText: '📋 Application ID: AA00FPUEXZ\n✅  APPLICATION SUBMITTED — CONFIRMATION',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.appId, 'AA00FPUEXZ')
})

test('exit 0 without submit is not success', () => {
  const result = classifyFillResult({
    code: 0,
    logText: 'Autofill stopped before submit and PDF save.',
  })
  assert.equal(result.status, 'blocked')
})

test('fatal exit is failed with log reason', () => {
  const result = classifyFillResult({
    code: 1,
    logText: 'Autofill failed: Cloudflare blocked\nFatal error — no more retries',
  })
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /Fatal error/i)
})

test('user stop is stopped', () => {
  assert.equal(classifyFillResult({ code: 1, stopped: true }).status, 'stopped')
})

test('extractFillReason prefers fatal line', () => {
  assert.match(
    extractFillReason('OPENAI_API_KEY is not set.\nFatal error — no more retries'),
    /Fatal error/,
  )
})

test('email subject and reason for a failed fill', () => {
  const { subject, text } = buildFillEmail({
    status: 'failed',
    name: 'nira_biton.txt',
    reason: 'Fatal error — no more retries',
    appId: 'AA00FPUEXZ',
    logExcerpt: 'Fatal error — no more retries',
  })
  assert.match(subject, /נכשל/)
  assert.match(subject, /nira_biton\.txt/)
  assert.match(text, /Fatal error/)
  assert.match(text, /AA00FPUEXZ/)
})

test('email event filter maps start/end/fail', () => {
  assert.equal(shouldEmailStatus('filling', 'start,fail'), true)
  assert.equal(shouldEmailStatus('succeeded', 'start,fail'), false)
  assert.equal(shouldEmailStatus('failed', 'start,end,fail'), true)
})

test('parallel chrome profiles are separate slot folders', async () => {
  const { chromeProfileDir, chromeProfileDirForSlot } = await import('../scripts/fill-ui/status.js')
  const base = chromeProfileDir()
  const slot1 = chromeProfileDirForSlot(1)
  const slot2 = chromeProfileDirForSlot(2)
  assert.equal(slot1, path.join(base, 'slot-1'))
  assert.equal(slot2, path.join(base, 'slot-2'))
  assert.notEqual(slot1, slot2)
})
