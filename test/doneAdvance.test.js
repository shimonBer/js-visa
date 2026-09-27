import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IDLE_NEXT_MS,
  isAdvanceClick,
  nextAdvanceAction,
  queueWithAdvance,
  shouldForceNextAfterIdle,
  stripDoneActions,
} from '../autofill/done-advance.js'

test('queueWithAdvance drops done and appends Next when the page is not finished', () => {
  const queue = queueWithAdvance(
    [
      { type: 'radio', ref: 'rblOtherEduc', value: 'Yes' },
      { type: 'wait' },
      { type: 'done' },
    ],
    { type: 'click', text: 'Next: Work/Education: Additional' },
  )
  assert.deepEqual(queue, [
    { type: 'radio', ref: 'rblOtherEduc', value: 'Yes' },
    { type: 'wait' },
    { type: 'click', text: 'Next: Work/Education: Additional' },
  ])
})

test('queueWithAdvance does not insert a second Next when one is already queued', () => {
  const queue = queueWithAdvance(
    [
      { type: 'wait' },
      { type: 'done' },
      { type: 'click', text: 'Next: Work/Education: Additional' },
    ],
    { type: 'click', text: 'Next' },
  )
  assert.deepEqual(queue, [
    { type: 'wait' },
    { type: 'click', text: 'Next: Work/Education: Additional' },
  ])
})

test('a done-only delta leaves an empty list so existing Next stays in the agent queue', () => {
  assert.deepEqual(stripDoneActions([{ type: 'done' }, { type: 'wait' }, { type: 'done' }]), [
    { type: 'wait' },
  ])
  assert.deepEqual(stripDoneActions([{ type: 'done' }]), [])
})

test('15s with no progress clicks Next on a form page and never on CAPTCHA or sign', () => {
  assert.equal(shouldForceNextAfterIdle(IDLE_NEXT_MS - 1, 'travel'), false)
  assert.equal(shouldForceNextAfterIdle(IDLE_NEXT_MS, 'travel'), true)
  assert.equal(shouldForceNextAfterIdle(IDLE_NEXT_MS, 'work_present'), true)
  assert.equal(shouldForceNextAfterIdle(IDLE_NEXT_MS, 'captcha'), false)
  assert.equal(shouldForceNextAfterIdle(IDLE_NEXT_MS, 'photo'), false)
  assert.equal(shouldForceNextAfterIdle(IDLE_NEXT_MS, 'sign_submit'), false)
  assert.equal(shouldForceNextAfterIdle(IDLE_NEXT_MS, 'signed'), false)
  assert.equal(shouldForceNextAfterIdle(IDLE_NEXT_MS, 'confirmation'), false)
})

test('nextAdvanceAction uses the visible Next button and never clicks Sign and Submit', () => {
  assert.deepEqual(
    nextAdvanceAction({
      pageContext: 'work_previous',
      inventory: { buttons: [{ text: 'Next: Work/Education: Additional' }] },
    }),
    { type: 'click', text: 'Next: Work/Education: Additional' },
  )
  assert.equal(
    nextAdvanceAction({
      pageContext: 'sign_submit',
      inventory: { buttons: [{ text: 'Sign and Submit Application' }] },
    }),
    null,
  )
  assert.equal(isAdvanceClick({ type: 'click', text: 'Next: Personal 2' }), true)
  assert.equal(isAdvanceClick({ type: 'done' }), false)
})
