import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  extractApplicationIdFromLog,
  lookupApplicationId,
  parseApplicationId,
  peekApplicationId,
  forgetApplicationId,
  rememberApplicationId,
} from '../autofill/application-id-store.js'
import { classifyFillResult } from '../scripts/fill-ui/status.js'
import { fillCliArgs, fillScript } from '../scripts/run-fill.js'

const STALL_LOG = `
[15:53:04.569] 💰 Token usage — prompt: 0 (cached: 0), completion: 0, total: 0
[15:53:04.569] ❌ Retry 2 failed ⛔ Stall detected — stuck on page "travel" for 61 consecutive steps (limit: 60). This usually means a CAPTCHA was not solved, a required field was missed, or a navigation button was not clicked. Aborting.
[15:53:04.570] ❌ Fatal error — no more retries ⛔ Stall detected — stuck on page "travel" for 61 consecutive steps (limit: 60). This usually means a CAPTCHA was not solved, a required field was missed, or a navigation button was not clicked. Aborting.
[15:53:04.570] Application ID for manual retrieve: AA00FSVJWL
[15:53:04.593] ⚠️  PAGE CLOSED (browser window was closed or tab crashed)
[15:53:04.640] ⚠️  BROWSER CONTEXT CLOSED
`

test('extractApplicationIdFromLog reads failure retrieve lines', () => {
  assert.equal(extractApplicationIdFromLog(STALL_LOG), 'AA00FSVJWL')
  assert.equal(extractApplicationIdFromLog('📋 Application ID: AA00FPUEXZ'), 'AA00FPUEXZ')
  assert.equal(extractApplicationIdFromLog('Using Application ID AA00FNI7C7'), 'AA00FNI7C7')
  assert.equal(extractApplicationIdFromLog('Will retry by retrieving Application ID AA00FQCBAB'), 'AA00FQCBAB')
  assert.equal(extractApplicationIdFromLog('no id here'), '')
})

test('failed stall log still classifies with an Application ID', () => {
  const result = classifyFillResult({ code: 1, logText: STALL_LOG })
  assert.equal(result.status, 'failed')
  assert.equal(result.appId, 'AA00FSVJWL')
  assert.match(result.reason, /Fatal error|Stall detected/i)
})

test('application ID store remembers by path, name, and form id', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds160-appid-'))
  const filePath = path.join(repoRoot, 'people', 'ofek_avraham_borus.txt')
  rememberApplicationId(repoRoot, {
    filePath,
    name: 'ofek_avraham_borus.txt',
    formId: 'form-ofek',
    appId: 'AA00FSVJWL',
  })
  assert.equal(peekApplicationId(repoRoot, { formId: 'form-ofek' }), 'AA00FSVJWL')
  assert.equal(lookupApplicationId(repoRoot, { filePath }), 'AA00FSVJWL')
  assert.equal(lookupApplicationId(repoRoot, { name: 'ofek_avraham_borus.txt' }), 'AA00FSVJWL')
  assert.equal(parseApplicationId('aa00fsvjwl'), 'AA00FSVJWL')
})

test('lookup recovers an Application ID from fill-events log excerpts', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds160-events-'))
  const eventsDir = path.join(repoRoot, 'autofill-output')
  fs.mkdirSync(eventsDir, { recursive: true })
  fs.writeFileSync(
    path.join(eventsDir, 'fill-events.jsonl'),
    `${JSON.stringify({
      name: 'ofek_avraham_borus.txt',
      status: 'failed',
      appId: '',
      logExcerpt: STALL_LOG,
    })}\n`,
  )
  assert.equal(
    lookupApplicationId(repoRoot, { name: 'ofek_avraham_borus.txt' }),
    'AA00FSVJWL',
  )
})

test('forgetting an application keeps old logs from restoring the ID', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds160-forget-'))
  const eventsDir = path.join(repoRoot, 'autofill-output')
  fs.mkdirSync(eventsDir, { recursive: true })
  fs.writeFileSync(
    path.join(eventsDir, 'fill-events.jsonl'),
    `${JSON.stringify({ name: 'ofek_avraham_borus.txt', appId: 'AA00FSVJWL', logExcerpt: '' })}\n`,
  )
  forgetApplicationId(repoRoot, { name: 'ofek_avraham_borus.txt' })
  assert.equal(lookupApplicationId(repoRoot, { name: 'ofek_avraham_borus.txt' }), '')
  rememberApplicationId(repoRoot, { name: 'ofek_avraham_borus.txt', appId: 'AA00NEWAPP' })
  assert.equal(lookupApplicationId(repoRoot, { name: 'ofek_avraham_borus.txt' }), 'AA00NEWAPP')
})

test('fillCliArgs resumes with --retrieve when an Application ID is known', () => {
  assert.deepEqual(fillCliArgs('/tmp/nira.txt'), [fillScript, '--input', '/tmp/nira.txt'])
  assert.deepEqual(
    fillCliArgs('/tmp/ofek.txt', { appId: 'AA00FSVJWL' }),
    [fillScript, '--input', '/tmp/ofek.txt', '--retrieve', '--app-id', 'AA00FSVJWL'],
  )
  assert.deepEqual(
    fillCliArgs('/tmp/ofek.txt', { appId: 'nope' }),
    [fillScript, '--input', '/tmp/ofek.txt'],
  )
  assert.deepEqual(
    fillCliArgs('/tmp/ofek.txt', { appId: 'AA00FSVJWL', fresh: true }),
    [fillScript, '--input', '/tmp/ofek.txt', '--fresh'],
  )
})
