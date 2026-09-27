import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isPhoneNumberField,
  normalizePhoneFieldsInAnswerSheet,
  normalizePhoneFieldsInSourceData,
  normalizePhoneFillValue,
  normalizePhoneNumbersInTranslatedText,
  phoneDigitsOrOriginal,
} from '../lib/phoneFormatting.js'

test('phoneDigitsOrOriginal strips punctuation and leaves markers alone', () => {
  assert.equal(phoneDigitsOrOriginal('+972 538055645'), '972538055645')
  assert.equal(phoneDigitsOrOriginal('+1 (347) 319-7820'), '13473197820')
  assert.equal(phoneDigitsOrOriginal('03-502-8211'), '035028211')
  assert.equal(phoneDigitsOrOriginal('N/A'), 'N/A')
  assert.equal(phoneDigitsOrOriginal('❗ MISSING'), '❗ MISSING')
  assert.equal(phoneDigitsOrOriginal(''), '')
})

test('translated phone lines become digits only', () => {
  const translated = [
    'Primary Phone Number: +972 538055645',
    'Secondary Phone Number: N/A',
    'Work Phone Number: 03-502-8211',
    'Additional Phone Number: +972-50-123-4567',
    'Have you used any other phone numbers in the last five years? YES',
    'Phone Number: +1 (646) 207-8814',
    'Employer Phone Number: 04-611-0011',
    'Telephone Number of Person Paying for Trip: +972 52-373-6990',
  ].join('\n')

  assert.equal(
    normalizePhoneNumbersInTranslatedText(translated),
    [
      'Primary Phone Number: 972538055645',
      'Secondary Phone Number: N/A',
      'Work Phone Number: 035028211',
      'Additional Phone Number: 972501234567',
      'Have you used any other phone numbers in the last five years? YES',
      'Phone Number: 16462078814',
      'Employer Phone Number: 046110011',
      'Telephone Number of Person Paying for Trip: 972523736990',
    ].join('\n'),
  )
})

test('fill-time phone values are digits only when the field looks like a phone', () => {
  assert.equal(
    normalizePhoneFillValue('+972 538055645', { label: 'Primary Phone Number' }),
    '972538055645',
  )
  assert.equal(
    normalizePhoneFillValue('+1 (904) 629-4006', { ref: 'tbxUS_POC_HOME_TEL' }),
    '19046294006',
  )
  assert.equal(
    normalizePhoneFillValue('HaAgur 4', { label: 'Street Address (Line 1)' }),
    'HaAgur 4',
  )
})

test('source intake phones are stripped before translation', () => {
  const normalized = normalizePhoneFieldsInSourceData({
    phoneCountryCode: '+972',
    phoneNumber: '53-805-5645',
    secondaryPhone: '',
    contactPhone: '+1 (555) 123-4567',
    otherPhones: [{ number: '+972 50-111-2222' }],
    previousEmployments: [{ phone: '04-611-0011' }],
  })

  assert.equal(normalized.phoneCountryCode, '972')
  assert.equal(normalized.phoneNumber, '538055645')
  assert.equal(normalized.contactPhone, '15551234567')
  assert.equal(normalized.otherPhones[0].number, '972501112222')
  assert.equal(normalized.previousEmployments[0].phone, '046110011')
})

test('answer-sheet phone keys are digits only', () => {
  const sheet = normalizePhoneFieldsInAnswerSheet({
    address: { primary_phone: '+972 538055645', email: 'a@b.com' },
    contact: { phone: '+1 (347) 319-7820' },
    work_present: { phone: '03-502-8211' },
  })

  assert.equal(sheet.address.primary_phone, '972538055645')
  assert.equal(sheet.address.email, 'a@b.com')
  assert.equal(sheet.contact.phone, '13473197820')
  assert.equal(sheet.work_present.phone, '035028211')
})

test('yes/no phone questions are not treated as phone-number fields', () => {
  assert.equal(
    isPhoneNumberField({ label: 'Have you used any other phone numbers in the last five years?' }),
    false,
  )
  assert.equal(isPhoneNumberField({ label: 'Primary Phone Number' }), true)
})
