/**
 * Pure DS-160 page-context detection from URL / heading text.
 * Used by Playwright and by the Chrome extension (no page handle).
 */

export function detectPageContextFromUrl(href) {
  try {
    const currentUrl = new URL(href, 'https://ceac.state.gov')
    const url = currentUrl.pathname.toLowerCase()
    const node = String(currentUrl.searchParams.get('node') || '').toLowerCase()

    if (node === 'spouse') return 'spouse'
    if (node === 'personal1' || node === 'personalinfo1') return 'personal1'
    if (node === 'personal2' || node === 'personalcont' || node === 'personalinfo2') {
      return 'personal2'
    }
    if (node === 'travel' || node === 'travelinfo') return 'travel'
    if (node === 'travelcompanions' || node === 'companion') return 'companions'
    if (node === 'previoustravel' || node === 'previousustravel' || node === 'prevtravel') {
      return 'prev_travel'
    }
    if (node === 'addressphone' || node === 'address') return 'address'
    if (node === 'passport') return 'passport'
    if (node === 'contactpeople') return 'contact'
    if (node === 'familyinfo' || node === 'family') return 'family'
    if (node === 'workeducation1') return 'work_present'
    if (node === 'workeducation2') return 'work_previous'
    if (node === 'workeducation3') return 'work_additional'
    if (node === 'workeducationtraining' || node === 'work') return 'work_edu'
    if (node.startsWith('securityandbackground') || node === 'security') return 'security'
    if (node === 'securequestion' || node === 'securityquestion' || node === 'appsecurityquestion') {
      return 'security_question'
    }
    if (node === 'review' || node === 'preview') return 'review'

    // complete_*.aspx wizard pages — check before Default.aspx (landing CAPTCHA).
    if (url.includes('personalcont') || url.includes('personal_cont')) return 'personal2'
    if (url.includes('complete_personal') || url.includes('personalinfo1') || url.includes('personal_info1')) {
      return 'personal1'
    }
    if (url.includes('personalinfo2') || url.includes('personal_info2')) return 'personal2'
    if (url.includes('complete_travelcompanion') || url.includes('travelcompanion') || url.includes('travel_companion')) {
      return 'companions'
    }
    if (url.includes('complete_travel') || url.includes('travelinfo') || url.includes('travel_info')) {
      return 'travel'
    }
    if (url.includes('complete_contact') || url.includes('addressphone') || url.includes('address_phone')) {
      return 'address'
    }
    if (url.includes('complete_family')) return 'family'
    if (url.includes('complete_security')) return 'security'
    if (url.includes('complete_work')) return 'work_edu'

    if (url.includes('default.aspx')) return 'captcha'
    // https://ceac.state.gov/GenNIV/  (no Default.aspx in the bar)
    if (/\/genniv\/?$/.test(url)) return 'captcha'
    if (url.includes('disclaimer')) return 'disclaimer'
    if (
      url.includes('confirmapplicationid') ||
      url.includes('appsecurityquestion') ||
      url.includes('securityquestion')
    ) {
      return 'security_question'
    }
    if (url.includes('travelinfo') || url.includes('travel_info')) return 'travel'
    if (url.includes('travelcompanion') || url.includes('travel_companion')) return 'companions'
    if (
      url.includes('previousustravel') ||
      url.includes('previoustravel') ||
      url.includes('previous_travel')
    ) {
      return 'prev_travel'
    }
    if (url.includes('addressphone') || url.includes('address_phone')) return 'address'
    if (url.includes('passport')) return 'passport'
    if (url.includes('workeducation1') || url.includes('work_education1')) return 'work_present'
    if (url.includes('workeducation2') || url.includes('work_education2')) return 'work_previous'
    if (url.includes('workeducation3') || url.includes('work_education3')) return 'work_additional'
    if (url.includes('workeducation') || url.includes('work_education')) return 'work_edu'
    if (url.includes('securityandbackground') || url.includes('security_background')) {
      return 'security'
    }
    if (url.includes('/photo/') || url.includes('uploadphoto') || url.includes('photo_upload')) {
      return 'photo'
    }
    if (
      node === 'done' ||
      url.includes('complete_done_confirmation') ||
      url.includes('done_confirmation')
    ) {
      return 'confirmation'
    }
    if (
      url.includes('signtheapplication') ||
      url.includes('/esign/') ||
      node === 'signcertify' ||
      (url.includes('sign') && url.includes('submit')) ||
      url.includes('signsubmit')
    ) {
      return 'sign_submit'
    }
    if (url.includes('review') || url.includes('preview')) return 'review'

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Pages that exist only after Personal Information 1 has been saved. */
const AFTER_PERSONAL1 = new Set([
  'personal2',
  'travel',
  'companions',
  'prev_travel',
  'address',
  'passport',
  'contact',
  'family',
  'spouse',
  'work_present',
  'work_previous',
  'work_additional',
  'work_edu',
  'security',
  'photo',
  'review',
  'sign_submit',
  'confirmation',
])

export function pageIsAfterPersonal1(pageContext) {
  return AFTER_PERSONAL1.has(pageContext)
}

export function detectPageContextFromHeading(text) {
  const t = String(text || '').toLowerCase()
  if (!t) return ''
  if (t.includes('personal information 1')) return 'personal1'
  if (t.includes('personal information 2')) return 'personal2'
  if (t.includes('travel information')) return 'travel'
  if (t.includes('travel companion')) return 'companions'
  if (t.includes('previous u.s. travel') || t.includes('previous us travel')) return 'prev_travel'
  if (t.includes('address') && t.includes('phone')) return 'address'
  if (t.includes('address')) return 'address'
  if (t.includes('passport')) return 'passport'
  if (t.includes('u.s. contact') || t.includes('point of contact')) return 'contact'
  if (t.includes('family information') && t.includes('spouse')) return 'spouse'
  if (t.includes('family')) return 'family'
  if (t.includes('additional work') || t.includes('additional education')) return 'work_additional'
  if (t.includes('previous work') || t.includes('previous education')) return 'work_previous'
  if (t.includes('present work') || t.includes('present education')) return 'work_present'
  if (t.includes('work') || t.includes('education')) return 'work_edu'
  if (t.includes('security') && t.includes('background')) return 'security'
  if (t.includes('upload photo') || t.includes('photo upload')) return 'photo'
  if (t === 'confirmation' || t.startsWith('confirmation')) return 'confirmation'
  if (t.includes('computer fraud') || t.includes('security question')) return 'security_question'
  if (t.includes('i have read') || t.includes('disclaimer') || t.includes('privacy act')) {
    return 'disclaimer'
  }
  if (t.includes('sign and submit') || t.includes('e-signature')) return 'sign_submit'
  if (t.includes('review') || t.includes('preview')) return 'review'
  return ''
}

export function detectPageContextFromUrlFallback(href) {
  try {
    const url = new URL(href, 'https://ceac.state.gov').pathname.toLowerCase()
    if (url.includes('contactpeople') || url.includes('contact')) return 'contact'
    if (url.includes('familyinfo') || url.includes('family')) return 'family'
  } catch { /* ignore */ }
  return 'unknown'
}

export function detectPageContext({ href = '', heading = '' } = {}) {
  const fromUrl = detectPageContextFromUrl(href)
  const fromHeading = detectPageContextFromHeading(heading)
  // Form heading wins over the Default.aspx landing URL (frames / wrapper).
  if (fromHeading && (fromUrl === 'captcha' || fromUrl === 'unknown')) return fromHeading
  if (fromUrl !== 'unknown') return fromUrl
  if (fromHeading) return fromHeading
  return detectPageContextFromUrlFallback(href)
}
