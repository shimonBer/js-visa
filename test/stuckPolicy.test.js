import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pageLooksComplete,
  shouldForceNextWhenStuck,
  shouldGiveUpWhenStuck,
} from '../extension/stuck-policy.js'

test('leftover fields do not block a Next click after two identical snapshots', () => {
  assert.equal(shouldForceNextWhenStuck(1), false)
  assert.equal(shouldForceNextWhenStuck(2), true)
  assert.equal(shouldGiveUpWhenStuck(2), false)
  assert.equal(shouldGiveUpWhenStuck(7), false)
  assert.equal(shouldGiveUpWhenStuck(8), true)
})

test('CAPTCHA landing never force-clicks Next', () => {
  assert.equal(shouldForceNextWhenStuck(8, { pageContext: 'captcha' }), false)
  assert.equal(
    shouldForceNextWhenStuck(8, {
      pageContext: 'unknown',
      href: 'https://ceac.state.gov/genniv/',
    }),
    false,
  )
  assert.equal(shouldForceNextWhenStuck(2, { pageContext: 'unknown' }), true)
  assert.equal(shouldForceNextWhenStuck(2, { pageContext: 'work_present' }), true)
  assert.equal(shouldForceNextWhenStuck(8, { pageContext: 'sign_submit' }), false)
  assert.equal(shouldForceNextWhenStuck(8, { pageContext: 'signed' }), false)
  assert.equal(shouldForceNextWhenStuck(8, { pageContext: 'confirmation' }), false)
  assert.equal(
    shouldForceNextWhenStuck(8, {
      pageContext: 'photo',
      href: 'https://ceac.state.gov/GenNIV/General/photo/photo_uploadthephoto.aspx?node=UploadPhoto',
    }),
    false,
  )
  assert.equal(
    shouldForceNextWhenStuck(2, {
      pageContext: 'photo',
      href: 'https://ceac.state.gov/GenNIV/General/photo/photo_confirmphoto.aspx?node=ConfirmPhoto',
    }),
    true,
  )
})

test('a complete-looking page still forces Next rather than idling', () => {
  const planned = {
    actions: [{ type: 'click', text: 'Next: Security and Background' }],
    unresolvedRequired: [],
  }
  assert.equal(pageLooksComplete(planned), true)
  assert.equal(shouldForceNextWhenStuck(3), true)
  assert.equal(shouldGiveUpWhenStuck(6), false)
})
