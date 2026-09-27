import { isBlockedSubmissionClick, filterTranslatedText, JVISA_PREPARER } from './agent.js'
import { MATCHER_PAGES, matchPage } from './match-page.js'
import { applyDateLabels } from './page-inventory.js'
import { detectPageContext } from './detect-page-context.js'
import { planPage } from './plan-page.js'
import { queueWithAdvance, stripDoneActions } from './done-advance.js'

function looksLikeCaptchaLanding(inventory, href, heading) {
  const url = String(href || '').toLowerCase()
  if (/default\.aspx/i.test(url)) return true
  if (/\/genniv\/?(\?|$)/i.test(url) && !/complete|common|photo/i.test(url)) return true
  const buttons = (inventory?.buttons || []).map((button) => button.text || '').join(' ')
  const blob = `${heading || ''} ${buttons}`.toLowerCase()
  return /start an application/i.test(blob)
}

function looksLikeDisclaimer(inventory, href, heading) {
  const blob = `${heading || ''} ${(inventory?.fields || []).map((f) => `${f.ref} ${f.label}`).join(' ')}`.toLowerCase()
  if (/default\.aspx/i.test(href || '')) return false
  return (
    /disclaimer/i.test(href || '') ||
    /i have read|chkagree|cbagree|privacy act|terms and conditions/.test(blob)
  )
}

function looksLikeSignSubmit(inventory, href, heading) {
  const blob = `${href || ''} ${heading || ''} ${(inventory?.fields || []).map((f) => `${f.ref} ${f.label}`).join(' ')}`
  return /signtheapplication|signcertify|pptnumtbx|codetextbox|did anyone assist you in filling out this application/i.test(
    blob,
  )
}

function passportNumberFromAnswers(answers = '') {
  return String(answers || '').match(/Passport Number:\s*([A-Za-z0-9]+)/i)?.[1]?.trim() || ''
}

function looksLikeConfirmation(href, heading) {
  const url = String(href || '').toLowerCase()
  const head = String(heading || '').toLowerCase()
  return (
    url.includes('complete_done_confirmation') ||
    /[?&]node=done\b/.test(url) ||
    head === 'confirmation' ||
    head.startsWith('confirmation')
  )
}

function looksLikeSignedSuccess(inventory, href, heading, signedSubmitted = false, hasSignButton = false) {
  if (hasSignButton) return false
  if (looksLikeConfirmation(href, heading)) return false
  if (signedSubmitted) return true
  const blob = `${href || ''} ${heading || ''} ${(inventory?.buttons || []).map((b) => b.text || '').join(' ')}`.toLowerCase()
  return /successfully signed and submitted/.test(blob)
}

function planSignedSuccess() {
  const next = { type: 'click', text: 'Next: Confirmation' }
  return {
    pageContext: 'signed',
    source: 'signed',
    actions: [next],
    nextClick: next,
    resolvedRefs: [],
    unresolvedRequired: [],
    note: 'Application is signed. Click Next: Confirmation.',
  }
}

function planConfirmation() {
  return {
    pageContext: 'confirmation',
    source: 'confirmation',
    actions: [{ type: 'click', text: 'Print Application' }],
    nextClick: null,
    resolvedRefs: [],
    unresolvedRequired: [],
    note: 'Save the confirmation PDF, then Print Application.',
  }
}

function planSignSubmit(answers, autonomous = false) {
  const ppt = passportNumberFromAnswers(answers)
  const actions = [
    {
      type: 'radio',
      ref: 'rblPREP_IND',
      label: 'Did anyone assist you in filling out this application?',
      value: 'Yes',
    },
    { type: 'wait' },
    {
      type: 'check',
      label: 'Does Not Apply',
      fieldLabel: 'Preparer Names',
    },
    {
      type: 'fill',
      label: 'Organization Name',
      value: JVISA_PREPARER.organization,
    },
    {
      type: 'fill',
      label: 'Street Address',
      value: JVISA_PREPARER.street,
    },
    {
      type: 'fill',
      label: 'City',
      value: JVISA_PREPARER.city,
    },
    {
      type: 'check',
      label: 'Does Not Apply',
      fieldLabel: 'State/Province',
    },
    {
      type: 'fill',
      label: 'Postal Zone/ZIP Code',
      value: JVISA_PREPARER.postal,
    },
    {
      type: 'selectOption',
      label: 'Country/Region',
      value: JVISA_PREPARER.country,
    },
    {
      type: 'selectOption',
      label: 'Relationship to You',
      value: JVISA_PREPARER.relationship,
    },
  ]
  if (ppt) {
    actions.push({
      type: 'fill',
      ref: 'PPTNumTbx',
      label: 'Passport/Travel Document Number',
      value: ppt,
    })
  }
  actions.push({ type: 'solveCaptcha' })
  if (autonomous) actions.push({ type: 'submitApplication' })
  return {
    pageContext: 'sign_submit',
    source: 'sign-prep',
    actions,
    nextClick: null,
    readyForNext: false,
    resolvedRefs: ppt ? ['PPTNumTbx'] : [],
    unresolvedRequired: ppt ? [] : [],
    note: 'Fill assistance=Yes with JVisa preparer, passport number, and CAPTCHA, then click Sign and Submit Application.',
  }
}

function inventoryHasFileInput(inventory) {
  return (inventory?.fields || []).some(
    (field) => field.kind === 'file' || /file/i.test(`${field.ref || ''} ${field.label || ''}`),
  )
}

function planPhotoPage(inventory, href, heading, autonomous) {
  const url = String(href || '').toLowerCase()
  const head = String(heading || '').toLowerCase()
  const buttons = inventory?.buttons || []
  const blob = `${head} ${buttons.map((button) => button.text || '').join(' ')}`.toLowerCase()
  const next = nextNavigationClick(inventory) || { type: 'click', text: 'Next' }

  if (inventoryHasFileInput(inventory)) {
    return {
      pageContext: 'photo',
      source: 'photo-upload',
      actions: [{ type: 'uploadPhoto' }],
      nextClick: null,
      resolvedRefs: [],
      unresolvedRequired: [],
      note: 'Attach the blank 600×600 test JPEG. Face checks are expected to fail.',
    }
  }

  if (/continue without/.test(blob) || buttons.some((button) => /btnNoImage/i.test(button.ref || ''))) {
    const skip = { type: 'click', text: 'Continue Without a Photo' }
    return {
      pageContext: 'photo',
      source: 'photo-upload',
      actions: [skip],
      nextClick: skip,
      resolvedRefs: [],
      unresolvedRequired: [],
      note: 'Blank photo failed validation — continue without a photo.',
    }
  }

  if (/confirmphoto/i.test(url) || /confirm photo/i.test(head)) {
    return {
      pageContext: 'photo',
      source: 'photo-confirm',
      actions: autonomous ? [next] : [],
      nextClick: next,
      resolvedRefs: [],
      unresolvedRequired: [],
      note: 'Confirm Photo — click Next to leave the photo section.',
    }
  }

  return {
    pageContext: 'photo',
    source: 'photo-upload',
    actions: [{ type: 'click', text: 'Upload Your Photo' }],
    nextClick: null,
    resolvedRefs: [],
    unresolvedRequired: [],
    note: 'Open the photo tool and attach the blank test JPEG.',
  }
}

function looksLikeSecurityQuestion(inventory, href, heading) {
  const blob = `${href || ''} ${heading || ''} ${(inventory?.fields || []).map((f) => `${f.ref} ${f.label}`).join(' ')}`
  return /securityquestion|ddlquestions|security question|confirmapplicationid|computer fraud/i.test(blob)
}

function agreeAction(inventory) {
  const field = (inventory?.fields || []).find(
    (f) => f.kind === 'checkbox' && /agree|privacy|terms|read/i.test(`${f.ref} ${f.label}`),
  )
  if (field) return { type: 'check', ref: field.ref }
  return { type: 'checkAgree' }
}

const DS160_SECURITY_QUESTION = 'WHAT WAS YOUR HOME PHONE NUMBER WHEN YOU WERE A CHILD?'
const DS160_SECURITY_ANSWER = '049824393'

function isBlankSelect(field) {
  const value = String(field?.value || '').trim()
  return !value || /select/i.test(value)
}

function securityQuestionActions(inventory) {
  const fields = inventory?.fields || []
  const actions = []
  const agree = fields.find(
    (f) => f.kind === 'checkbox' && /agree|privacy|terms|read/i.test(`${f.ref} ${f.label}`),
  )
  if (!agree || agree.value !== 'checked') {
    actions.push({ type: 'checkAgree' }, { type: 'wait' })
  }
  const question = fields.find((f) => /ddlquestions|securityquestion/i.test(`${f.ref} ${f.label}`))
  if (!question || isBlankSelect(question)) {
    actions.push({ type: 'selectSecurityQuestion', value: DS160_SECURITY_QUESTION })
  }
  const answer = fields.find((f) => /txtanswer|securityanswer/i.test(f.ref || ''))
  if (!answer || !String(answer.value || '').trim()) {
    actions.push({ type: 'fillSecurityAnswer', value: DS160_SECURITY_ANSWER })
  }
  actions.push(nextNavigationClick(inventory) || { type: 'click', text: 'Continue' })
  return actions
}

function startApplicationClick(inventory) {
  const btn = inventory?.buttons?.find((b) => /start an application/i.test(b.text || ''))
  return { type: 'click', text: btn?.text || 'START AN APPLICATION' }
}

function nextNavigationClick(inventory) {
  const buttons = inventory?.buttons || []
  const next =
    buttons.find((b) => /^next\b/i.test(b.text || '')) ||
    buttons.find((b) => /^continue\b/i.test(b.text || ''))
  if (!next) return null
  const action = { type: 'click', text: next.text }
  return isBlockedSubmissionClick(action) ? null : action
}

function isPlanNavClick(action) {
  if (!action) return false
  if (action.type === 'reviewNext') return true
  if (action.type !== 'click') return false
  return /^(next|continue)\b/i.test(String(action.text || action.label || ''))
}

async function plannerRemainder({ ctx, labeled, sectionAnswers, unresolved, apiKey }) {
  const planned = await planPage({
    pageContext: ctx,
    inventory: { ...labeled, fields: unresolved },
    answers: sectionAnswers,
    validationErrors: labeled.errors || [],
    apiKey,
  })
  return stripDoneActions(planned.actions || []).filter((action) => {
    if (isBlockedSubmissionClick(action)) return false
    if (isPlanNavClick(action)) return false
    return true
  })
}

/**
 * Plan the current CEAC page. When autonomous=true, include Next/Start clicks
 * and use the LLM planner for sections the matcher does not cover.
 */
export async function planCurrentPage({
  href = '',
  heading = '',
  pageContext,
  inventory,
  answers = '',
  answerSheet = null,
  autonomous = false,
  apiKey = '',
  signedSubmitted = false,
  hasSignButton = false,
} = {}) {
  const labeled = applyDateLabels(inventory || { fields: [], buttons: [], errors: [] })
  let ctx = pageContext || detectPageContext({ href, heading })
  const signVisible =
    hasSignButton ||
    (labeled.buttons || []).some((button) =>
      /sign and submit application|btnSignApp/i.test(`${button.text || ''} ${button.ref || ''}`),
    )
  if (looksLikeSignedSuccess(labeled, href, heading, signedSubmitted, signVisible)) ctx = 'signed'
  if (
    (ctx === 'unknown' || ctx === 'captcha' || ctx === 'disclaimer') &&
    looksLikeSecurityQuestion(labeled, href, heading)
  ) {
    ctx = 'security_question'
  } else if (ctx === 'unknown' || ctx === 'captcha') {
    if (looksLikeDisclaimer(labeled, href, heading)) ctx = 'disclaimer'
    else if (looksLikeSignSubmit(labeled, href, heading)) ctx = 'sign_submit'
    else if (looksLikeCaptchaLanding(labeled, href, heading)) ctx = 'captcha'
  }
  const sectionAnswers = answers ? filterTranslatedText(answers, ctx) : ''
  const sheet = answerSheet?.[ctx]

  if (ctx === 'signed') {
    return planSignedSuccess()
  }

  if (ctx === 'confirmation') {
    return planConfirmation()
  }

  if (ctx === 'sign_submit') {
    return planSignSubmit(sectionAnswers, autonomous)
  }

  if (ctx === 'photo') {
    return planPhotoPage(labeled, href, heading, autonomous)
  }

  if (ctx === 'captcha') {
    const actions = [
      { type: 'selectEmbassy', value: 'Tel Aviv' },
      { type: 'solveCaptcha' },
    ]
    if (autonomous) actions.push(startApplicationClick(labeled))
    return {
      pageContext: 'captcha',
      source: 'captcha-ocr',
      actions,
      nextClick: autonomous ? startApplicationClick(labeled) : null,
      resolvedRefs: [],
      unresolvedRequired: [],
      note: autonomous
        ? 'OCR the letter CAPTCHA, select Tel Aviv, then click Start. Cloudflare Turnstile is still manual.'
        : 'OCR the letter CAPTCHA and select Tel Aviv. You click Start / Continue. Cloudflare Turnstile is still manual.',
    }
  }

  if (ctx === 'disclaimer') {
    const next = nextNavigationClick(labeled) || { type: 'click', text: 'Continue' }
    return {
      pageContext: 'disclaimer',
      source: 'setup',
      actions: [agreeAction(labeled), next],
      nextClick: next,
      resolvedRefs: [],
      unresolvedRequired: [],
      note: 'Check I agree, then Continue.',
    }
  }

  if (ctx === 'security_question') {
    return {
      pageContext: 'security_question',
      source: 'setup',
      actions: securityQuestionActions(labeled),
      nextClick: nextNavigationClick(labeled),
      resolvedRefs: [],
      unresolvedRequired: [],
      note: 'Set the security question and continue.',
    }
  }

  if (MATCHER_PAGES.has(ctx)) {
    const matched = matchPage({
      pageContext: ctx,
      inventory: labeled,
      answers: sectionAnswers,
      answerSheet: sheet,
    })
    const actions = [...matched.actions]
    let source = 'matcher'
    let unresolvedRequired = matched.unresolvedRequired
    const resolved = new Set(matched.resolvedRefs || [])
    if (autonomous && apiKey && (unresolvedRequired.length || actions.length === 0)) {
      const remainderFields = unresolvedRequired.length ? unresolvedRequired : labeled.fields
      const extras = await plannerRemainder({
        ctx,
        labeled: { ...labeled, fields: remainderFields },
        sectionAnswers,
        unresolved: remainderFields,
        apiKey,
      })
      for (const action of extras) {
        if (action.ref && resolved.has(action.ref)) continue
        actions.push(action)
        if (action.ref) resolved.add(action.ref)
      }
      if (extras.length) {
        source = actions.length === extras.length ? 'planner' : 'matcher+planner'
        unresolvedRequired = []
      }
    }
    const readyForNext =
      Boolean(matched.nextClick) &&
      unresolvedRequired.length === 0
    if (autonomous && matched.nextClick && !isBlockedSubmissionClick(matched.nextClick) && readyForNext) {
      actions.push(matched.nextClick)
    }
    return {
      pageContext: ctx,
      source,
      ...matched,
      actions,
      nextClick: readyForNext ? matched.nextClick : null,
      unresolvedRequired,
      resolvedRefs: [...resolved],
      readyForNext,
    }
  }

  if (autonomous && ctx === 'review') {
    const next = nextNavigationClick(labeled)
    return {
      pageContext: ctx,
      source: 'review',
      actions: next ? [next] : [],
      nextClick: next,
      resolvedRefs: [],
      unresolvedRequired: [],
      note: next ? 'Advancing review.' : 'No Next on this review page.',
    }
  }

  if (autonomous && apiKey) {
    const planned = await planPage({
      pageContext: ctx,
      inventory: labeled,
      answers: sectionAnswers,
      validationErrors: labeled.errors || [],
      apiKey,
    })
    const nextClick = nextNavigationClick(labeled)
    const actions = queueWithAdvance(
      (planned.actions || []).filter((action) => !isBlockedSubmissionClick(action)),
      nextClick,
    )
    return {
      pageContext: ctx,
      source: 'planner',
      actions,
      nextClick,
      resolvedRefs: [],
      unresolvedRequired: labeled.fields?.filter((f) => f.required && !f.value) || [],
    }
  }

  return {
    pageContext: ctx,
    source: 'unmatched',
    actions: [],
    nextClick: null,
    resolvedRefs: [],
    unresolvedRequired: labeled.fields?.filter((f) => f.required && !f.value) || [],
    note: operatorNote(ctx),
  }
}

function operatorNote(pageContext) {
  if (pageContext === 'disclaimer') {
    return 'Accept the disclaimer, then Fill on the form pages.'
  }
  return `No filler for this page (${pageContext}). Go to a form section such as Personal Information 1, then Fill.`
}
