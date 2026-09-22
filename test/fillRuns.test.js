import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractRunScreenshot,
  fileStem,
  groupFillRuns,
  intakeForPrior,
  isAutofillSourceName,
  shouldAutoPlayDownload,
  isTodoItem,
  portalStatus,
  reviveQueueItem,
  sectionId,
  selectionAfterStatus,
} from '../scripts/fill-ui/runs.js'

test('new work stays selected and a success leaves the batch', () => {
  assert.equal(selectionAfterStatus('idle', true), true)
  assert.equal(selectionAfterStatus('failed', true), true)
  assert.equal(selectionAfterStatus('blocked', true), true)
  assert.equal(selectionAfterStatus('succeeded', true), false)
  assert.equal(selectionAfterStatus('filling', false), true)
})

test('a waiting checked download auto-starts, a finished one does not', () => {
  assert.equal(shouldAutoPlayDownload({ id: '1', status: 'idle', selected: true }), true)
  assert.equal(shouldAutoPlayDownload({ id: '1', status: 'idle', selected: false }), false)
  assert.equal(shouldAutoPlayDownload({ id: '1', status: 'succeeded', selected: true }), false)
  assert.equal(shouldAutoPlayDownload({ id: '1', status: 'filling', selected: true }), false)
  assert.equal(shouldAutoPlayDownload(null), false)
})

test('portal status collapses fill outcomes', () => {
  assert.equal(portalStatus('queued'), 'pending')
  assert.equal(portalStatus('filling'), 'pending')
  assert.equal(portalStatus('succeeded'), 'success')
  assert.equal(portalStatus('failed'), 'fail')
  assert.equal(portalStatus('blocked'), 'fail')
  assert.equal(portalStatus('stopped'), 'stopped')
})

test('groupFillRuns keeps one row per run and the latest outcome', () => {
  const runs = groupFillRuns([
    { runId: 'a', ts: '2026-09-22T01:00:00.000Z', name: 'nira.txt', status: 'filling' },
    {
      runId: 'a',
      ts: '2026-09-22T01:05:00.000Z',
      name: 'nira.txt',
      status: 'succeeded',
      appId: 'AA00AAAAAA',
      logExcerpt: 'APPLICATION SUBMITTED',
      shotFile: 'a.jpg',
    },
    { runId: 'b', ts: '2026-09-22T02:00:00.000Z', name: 'form9.txt', status: 'failed', reason: 'Fatal error' },
  ])
  assert.equal(runs.length, 2)
  assert.equal(runs[0].id, 'b')
  assert.equal(runs[0].portalStatus, 'fail')
  assert.equal(runs[1].portalStatus, 'success')
  assert.equal(runs[1].startedAt, '2026-09-22T01:00:00.000Z')
  assert.equal(runs[1].logExcerpt, 'APPLICATION SUBMITTED')
  assert.equal(runs[1].shotFile, 'a.jpg')
  assert.equal(runs[1].appId, 'AA00AAAAAA')
})

test('a file that already ran is not selected again', () => {
  assert.deepEqual(intakeForPrior(null), { status: 'idle', selected: true })
  assert.deepEqual(intakeForPrior({ status: 'succeeded' }), { status: 'succeeded', selected: false })
  assert.deepEqual(intakeForPrior({ status: 'failed' }), { status: 'failed', selected: false })
  assert.equal(isAutofillSourceName('nira_biton_auto_fill.txt'), true)
  assert.equal(isAutofillSourceName('nira_biton_auto_fill (1).txt'), true)
  assert.equal(isAutofillSourceName('nira_biton.txt'), false)
  assert.equal(fileStem('nira_biton_auto_fill (1).txt'), 'nira_biton')
})

test('done runs leave the to-do section until checked, and a closed window restores them', () => {
  assert.equal(sectionId({ status: 'idle', selected: true }), 'todo')
  assert.equal(sectionId({ status: 'failed', selected: false }), 'failed')
  assert.equal(sectionId({ status: 'succeeded', selected: true }), 'succeeded')
  assert.equal(isTodoItem({ status: 'succeeded', selected: true }), false)
  assert.equal(isTodoItem({ status: 'idle', selected: false }), true)
  const revived = reviveQueueItem({
    id: '1',
    name: 'nira_biton_auto_fill.txt',
    path: '/tmp/nira_biton_auto_fill.txt',
    status: 'filling',
    selected: true,
  })
  assert.equal(revived.status, 'idle')
  assert.equal(revived.selected, true)
})

test('extractRunScreenshot reads the fill log marker', () => {
  assert.equal(
    extractRunScreenshot('[12:01:02.003] RUN_SCREENSHOT: /tmp/run-1.jpg\n'),
    '/tmp/run-1.jpg',
  )
  assert.equal(extractRunScreenshot('no shot'), '')
})
