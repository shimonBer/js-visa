/** Retry and CAPTCHA policy for the Sign and Submit page. */

export const MAX_CAPTCHA_TRIES = 12
export const MAX_SIGN_SUBMIT_TRIES = 12

/** Leftover box values are often OCR mistakes (O/Q, 0/O). Always re-read the image. */
export function shouldReuseVisibleCaptcha() {
  return false
}

/** After a failed submit, force a new BotDetect image before the next OCR. */
export function shouldRefreshCaptchaBeforeOcr(attempt) {
  return attempt > 1
}
