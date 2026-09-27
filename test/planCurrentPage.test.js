import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright'

import { filterTranslatedText, parseCaptchaOcrText } from '../autofill/agent.js'
import { detectPageContext, detectPageContextFromUrl } from '../autofill/detect-page-context.js'
import { matchPage } from '../autofill/match-page.js'
import { extractPageInventory } from '../autofill/page-inventory.js'
import { parseApplicantSource } from '../autofill/parse-applicant-source.js'
import { planCurrentPage } from '../autofill/plan-current-page.js'

test('URL node Personal1 maps to personal1', () => {
  assert.equal(
    detectPageContextFromUrl('https://ceac.state.gov/GenNIV/general/complete.aspx?node=Personal1'),
    'personal1',
  )
  assert.equal(
    detectPageContextFromUrl(
      'https://ceac.state.gov/GenNIV/General/complete/complete_personal.aspx?node=Personal1',
    ),
    'personal1',
  )
  assert.equal(
    detectPageContextFromUrl('https://ceac.state.gov/GenNIV/Default.aspx'),
    'captcha',
  )
  assert.equal(
    detectPageContextFromUrl('https://ceac.state.gov/genniv/'),
    'captcha',
  )
  assert.equal(
    detectPageContext({
      href: 'https://ceac.state.gov/genniv/',
      heading: 'Online Nonimmigrant Visa Application (DS-160)',
    }),
    'captcha',
  )
  assert.equal(
    detectPageContextFromUrl(
      'https://ceac.state.gov/GenNIV/Common/ConfirmApplicationID.aspx?node=SecureQuestion',
    ),
    'security_question',
  )
  assert.equal(
    detectPageContextFromUrl('https://ceac.state.gov/GenNIV/Common/ConfirmApplicationID.aspx'),
    'security_question',
  )
  assert.equal(
    detectPageContext({
      href: 'https://ceac.state.gov/GenNIV/General/complete/complete.aspx',
      heading: 'Computer Fraud and Abuse Act Notices',
    }),
    'security_question',
  )
  assert.equal(
    detectPageContext({
      href: 'https://ceac.state.gov/GenNIV/general/complete.aspx',
      heading: 'Personal Information 1',
    }),
    'personal1',
  )
  assert.equal(
    detectPageContextFromUrl(
      'https://ceac.state.gov/GenNIV/General/esign/signtheapplication.aspx?node=SignCertify',
    ),
    'sign_submit',
  )
  assert.equal(
    detectPageContext({
      href: 'https://ceac.state.gov/GenNIV/General/esign/signtheapplication.aspx?node=SignCertify',
      heading: 'Online Nonimmigrant Visa Application (DS-160)',
    }),
    'sign_submit',
  )
  assert.equal(
    detectPageContextFromUrl(
      'https://ceac.state.gov/GenNIV/General/ESign/Complete_Done_Confirmation.aspx?node=Done',
    ),
    'confirmation',
  )
  assert.equal(
    detectPageContext({
      href: 'https://ceac.state.gov/GenNIV/General/ESign/Complete_Done_Confirmation.aspx?node=Done',
      heading: 'Confirmation',
    }),
    'confirmation',
  )
})

test('captcha landing page plans letter OCR, not an empty skip', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/Default.aspx',
    inventory: { fields: [], buttons: [], errors: [] },
  })
  assert.equal(planned.pageContext, 'captcha')
  assert.equal(planned.source, 'captcha-ocr')
  assert.ok(planned.actions.some((a) => a.type === 'solveCaptcha'))
  assert.ok(planned.actions.some((a) => a.type === 'selectEmbassy'))
  assert.equal(planned.actions.some((a) => a.type === 'click'), false)
  assert.equal(parseCaptchaOcrText('Ab12'), 'Ab12')
  assert.equal(parseCaptchaOcrText('too long to be a captcha answer'), '')
})

test('autonomous captcha plan includes Start an Application', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/Default.aspx',
    inventory: {
      fields: [],
      buttons: [{ text: 'START AN APPLICATION', triggersPostback: true }],
      errors: [],
    },
    autonomous: true,
  })
  assert.ok(planned.actions.some((a) => a.type === 'click' && /start an application/i.test(a.text)))
})

test('bare /genniv/ landing OCRs CAPTCHA instead of planner Next', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/genniv/',
    heading: 'Online Nonimmigrant Visa Application (DS-160)',
    inventory: {
      fields: [],
      buttons: [{ text: 'START AN APPLICATION', triggersPostback: true }],
      errors: [],
    },
    autonomous: true,
    apiKey: 'sk-test',
  })
  assert.equal(planned.pageContext, 'captcha')
  assert.equal(planned.source, 'captcha-ocr')
  assert.ok(planned.actions.some((a) => a.type === 'solveCaptcha'))
  assert.equal(
    planned.actions.some((a) => a.type === 'click' && /next/i.test(a.text || '')),
    false,
  )
})

test('upload photo page opens the photo tool instead of stopping', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/General/photo/photo_uploadthephoto.aspx?node=UploadPhoto',
    heading: 'Upload Photo',
    inventory: { fields: [], buttons: [], errors: [] },
    autonomous: true,
  })
  assert.equal(planned.pageContext, 'photo')
  assert.equal(planned.stop, undefined)
  assert.equal(planned.source, 'photo-upload')
  assert.ok(planned.actions.some((a) => a.type === 'click' && /upload your photo/i.test(a.text)))
})

test('photo tool with a file input plans the blank JPEG upload', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/General/photo/phototool.aspx',
    heading: 'Photo Quality',
    inventory: {
      fields: [{ ref: 'filePhoto', kind: 'file', label: 'Photo' }],
      buttons: [],
      errors: [],
    },
    autonomous: true,
  })
  assert.ok(planned.actions.some((a) => a.type === 'uploadPhoto'))
})

test('confirm photo page clicks Next', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/General/photo/photo_confirmphoto.aspx?node=ConfirmPhoto',
    heading: 'Confirm Photo',
    inventory: {
      fields: [],
      buttons: [{ text: 'Next', triggersPostback: true }],
      errors: [],
    },
    autonomous: true,
  })
  assert.equal(planned.source, 'photo-confirm')
  assert.ok(planned.actions.some((a) => a.type === 'click' && /^next/i.test(a.text)))
})

test('sign and submit fills passport and CAPTCHA, then clicks Sign', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/General/esign/signtheapplication.aspx?node=SignCertify',
    heading: 'Online Nonimmigrant Visa Application (DS-160)',
    inventory: { fields: [], buttons: [{ text: 'Sign and Submit Application' }], errors: [] },
    answers: '🟦 PASSPORT INFORMATION\nPassport Number: 40335073\n',
    autonomous: true,
  })
  assert.equal(planned.pageContext, 'sign_submit')
  assert.equal(planned.stop, undefined)
  assert.ok(planned.actions.some((a) => a.type === 'radio' && a.value === 'Yes'))
  assert.ok(planned.actions.some((a) => a.type === 'fill' && a.ref === 'PPTNumTbx' && a.value === '40335073'))
  assert.ok(planned.actions.some((a) => a.type === 'solveCaptcha'))
  assert.ok(planned.actions.some((a) => a.type === 'submitApplication'))
  assert.equal(
    planned.actions.some((a) => a.type === 'click' && /sign and submit/i.test(a.text || '')),
    false,
  )
  assert.equal(parseCaptchaOcrText("I'm sorry, I can't assist with that."), '')
  assert.equal(parseCaptchaOcrText('619335'), '619335')
})

test('unsigned Sign page with Next: Confirmation still plans Sign, not Next', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/General/esign/signtheapplication.aspx?node=SignCertify',
    heading: 'Sign and Submit',
    inventory: {
      fields: [],
      buttons: [{ text: 'Next: Confirmation' }, { text: 'Sign and Submit Application', ref: 'btnSignApp' }],
      errors: [],
    },
    answers: '🟦 PASSPORT INFORMATION\nPassport Number: 40335073\n',
    autonomous: true,
    hasSignButton: true,
  })
  assert.equal(planned.pageContext, 'sign_submit')
  assert.ok(planned.actions.some((a) => a.type === 'submitApplication'))
  assert.equal(planned.actions.some((a) => a.type === 'click' && /next/i.test(a.text || '')), false)
})

test('signed success page clicks Next: Confirmation, not Sign', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/General/esign/signtheapplication.aspx?node=SignCertify',
    heading: 'Online Nonimmigrant Visa Application (DS-160)',
    inventory: { fields: [], buttons: [{ text: 'Next' }], errors: [] },
    signedSubmitted: true,
    autonomous: true,
  })
  assert.equal(planned.pageContext, 'signed')
  assert.ok(planned.actions.some((a) => a.type === 'click' && a.text === 'Next: Confirmation'))
  assert.equal(planned.actions.some((a) => a.type === 'submitApplication'), false)
})

test('confirmation page plans Print Application after save', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/General/ESign/Complete_Done_Confirmation.aspx?node=Done',
    heading: 'Confirmation',
    inventory: { fields: [], buttons: [{ text: 'Print Application' }], errors: [] },
    autonomous: true,
  })
  assert.equal(planned.pageContext, 'confirmation')
  assert.ok(planned.actions.some((a) => a.type === 'click' && a.text === 'Print Application'))
  assert.equal(planned.actions.some((a) => a.type === 'submitApplication'), false)
})

test('disclaimer page checks I agree then Continue', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/General/complete/complete.aspx',
    heading: 'I have read and understood the information above',
    inventory: {
      fields: [{ ref: 'chkAgree', kind: 'checkbox', label: 'I agree', value: '', required: true }],
      buttons: [{ text: 'Continue', triggersPostback: true }],
      errors: [],
    },
  })
  assert.equal(planned.pageContext, 'disclaimer')
  assert.equal(planned.actions[0].type, 'check')
  assert.equal(planned.actions[0].ref, 'chkAgree')
  assert.equal(planned.actions[1].type, 'click')
})

test('security question page checks I agree then sets the question', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/Common/ConfirmApplicationID.aspx?node=SecureQuestion',
    heading: 'Computer Fraud and Abuse Act Notices',
    inventory: {
      fields: [
        { ref: 'ddlQuestions', kind: 'select', label: 'Security Question', value: '', options: [] },
      ],
      buttons: [{ text: 'Continue', triggersPostback: true }],
      errors: [],
    },
  })
  assert.equal(planned.pageContext, 'security_question')
  assert.equal(planned.actions[0].type, 'checkAgree')
  assert.ok(planned.actions.some((a) => a.type === 'selectSecurityQuestion'))
  assert.ok(planned.actions.some((a) => a.type === 'fillSecurityAnswer'))
})

test('CFAA notices with only I Agree still plans the security question', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/Common/ConfirmApplicationID.aspx',
    heading: 'Computer Fraud and Abuse Act Notices',
    inventory: {
      fields: [{ ref: 'chkAgree', kind: 'checkbox', label: 'I agree', value: '', required: true }],
      buttons: [{ text: 'Continue', triggersPostback: true }],
      errors: [],
    },
  })
  assert.equal(planned.pageContext, 'security_question')
  assert.ok(planned.actions.some((a) => a.type === 'checkAgree'))
  assert.ok(planned.actions.some((a) => a.type === 'selectSecurityQuestion'))
  assert.ok(planned.actions.some((a) => a.type === 'fillSecurityAnswer'))
})

test('security question skips I Agree when it is already checked', async () => {
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/Common/ConfirmApplicationID.aspx?node=SecureQuestion',
    heading: 'Computer Fraud and Abuse Act Notices',
    inventory: {
      fields: [
        { ref: 'chkAgree', kind: 'checkbox', label: 'I agree', value: 'checked' },
        { ref: 'ddlQuestions', kind: 'select', label: 'Security Question', value: '', options: [] },
      ],
      buttons: [{ text: 'Continue', triggersPostback: true }],
      errors: [],
    },
  })
  assert.equal(planned.pageContext, 'security_question')
  assert.equal(planned.actions.some((a) => a.type === 'checkAgree'), false)
  assert.ok(planned.actions.some((a) => a.type === 'selectSecurityQuestion'))
})

test('planCurrentPage matches matchPage on a personal1 snapshot', async () => {
  const source = readFileSync('people/form8.txt', 'utf8')
  const parsed = parseApplicantSource(source)
  const html = readFileSync('dom-snapshots/personal1--expanded.html', 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const inventory = await extractPageInventory(page)
    const href = 'https://ceac.state.gov/GenNIV/general/complete.aspx?node=Personal1'
    const planned = await planCurrentPage({
      href,
      inventory,
      answers: parsed.text,
      answerSheet: parsed.answerSheet,
    })
    const matched = matchPage({
      pageContext: 'personal1',
      inventory,
      answers: filterTranslatedText(parsed.text, 'personal1'),
      answerSheet: parsed.answerSheet?.personal1,
    })
    assert.equal(planned.pageContext, 'personal1')
    assert.equal(planned.source, 'matcher')
    assert.deepEqual(planned.actions, matched.actions)
  } finally {
    await browser.close()
  }
})

test('autonomous additional-work plan does not click Next while radios are unanswered', async () => {
  const parsed = parseApplicantSource(readFileSync('people/form9.txt', 'utf8'))
  const planned = await planCurrentPage({
    href: 'https://ceac.state.gov/GenNIV/general/complete.aspx?node=WorkEducation3',
    heading: 'Additional Work/Education/Training Information',
    inventory: {
      fields: [
        {
          ref: 'rblCLAN_TRIBE_IND',
          kind: 'radio',
          label: 'Do you belong to a clan or tribe?',
          value: '',
          required: true,
          options: ['Yes', 'No'],
        },
        {
          ref: 'tbxLANGUAGE_NAME',
          kind: 'text',
          label: 'Language Name',
          value: 'ENGLISH',
          required: true,
        },
        {
          ref: 'rblCOUNTRIES_VISITED_IND',
          kind: 'radio',
          label: 'Have you traveled to any countries/regions within the last five years?',
          value: '',
          required: true,
          options: ['Yes', 'No'],
        },
      ],
      buttons: [{ text: 'Next: Security and Background' }],
      errors: ['The question "Do you belong to a clan or tribe?" has not been answered.'],
    },
    answers: parsed.text,
    answerSheet: parsed.answerSheet,
    autonomous: true,
  })
  assert.equal(planned.pageContext, 'work_additional')
  assert.equal(planned.readyForNext, false)
  assert.equal(
    planned.actions.some((action) => action.type === 'click' && /^next\b/i.test(action.text || '')),
    false,
  )
  assert.ok(planned.actions.some((action) => action.type === 'radio'))
})
