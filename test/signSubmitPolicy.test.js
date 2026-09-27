import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_CAPTCHA_TRIES,
  MAX_SIGN_SUBMIT_TRIES,
  shouldRefreshCaptchaBeforeOcr,
  shouldReuseVisibleCaptcha,
} from '../extension/sign-submit-policy.js'

test('sign-submit retries the letter CAPTCHA well past a couple of OCR misses', () => {
  assert.equal(MAX_SIGN_SUBMIT_TRIES, 12)
  assert.equal(MAX_CAPTCHA_TRIES, 12)
  assert.equal(shouldReuseVisibleCaptcha(), false)
  assert.equal(shouldRefreshCaptchaBeforeOcr(1), false)
  assert.equal(shouldRefreshCaptchaBeforeOcr(2), true)
  assert.equal(shouldRefreshCaptchaBeforeOcr(12), true)
})
