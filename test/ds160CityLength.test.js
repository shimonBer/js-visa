import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cityTooLongMessage,
  collectOverlongCityPaths,
  collectOverlongFieldPaths,
  fieldTooLongMessage,
  fitDs160Phone,
  fitDs160Value,
  limitForPortalField,
  shortenCitiesInAnswerSheet,
  shortenCitiesInTranslatedText,
  shortenDs160City,
} from '../lib/ds160CityLength.js'

test('administrative city suffixes drop before the 20 character limit', () => {
  assert.equal(shortenDs160City('Maale Gamla regional council'), 'Maale Gamla')
  assert.equal(shortenDs160City('Maale Yosef Regional Council'), 'Maale Yosef')
  assert.equal(shortenDs160City('Tel Aviv'), 'Tel Aviv')
  assert.equal(shortenDs160City('Salt Lake City'), 'Salt Lake City')
  assert.equal(shortenDs160City('N/A'), 'N/A')
  assert.equal(shortenDs160City('❗ MISSING'), '❗ MISSING')
})

test('a long city drops whole words instead of cutting mid-word', () => {
  assert.equal(shortenDs160City('A Very Long City Name Indeed').length <= 20, true)
  assert.equal(shortenDs160City('A Very Long City Name Indeed'), 'A Very Long City')
})

test('translated city lines and answer-sheet cities are shortened', () => {
  const text = [
    'City of Birth: Jerusalem',
    'Employer City: Maale Gamla regional council',
    'Describe Your Duties: Lawyer in the contracts department',
  ].join('\n')
  assert.equal(
    shortenCitiesInTranslatedText(text),
    [
      'City of Birth: Jerusalem',
      'Employer City: Maale Gamla',
      'Describe Your Duties: Lawyer in the contracts department',
    ].join('\n'),
  )

  const sheet = shortenCitiesInAnswerSheet({
    city_of_birth: 'Maale Gamla regional council',
    previous_employers: [{ employer_city: 'Petah Tikva' }],
  })
  assert.equal(sheet.city_of_birth, 'Maale Gamla')
  assert.equal(sheet.previous_employers[0].employer_city, 'Petah Tikva')
})

test('official limits warn in Hebrew and the translation is shortened to fit', () => {
  assert.equal(limitForPortalField('passportIssuingCity'), 25)
  assert.equal(limitForPortalField('birthCity'), 20)
  assert.equal(limitForPortalField('firstNameEnglish'), 33)
  assert.equal(limitForPortalField('addressStreet'), 40)
  assert.equal(limitForPortalField('phoneNumber'), 15)
  assert.equal(fieldTooLongMessage('passportIssuingCity', 'A'.repeat(21)), '')
  assert.match(fieldTooLongMessage('lastNameEnglish', 'A'.repeat(34)), /33/)
  assert.match(fieldTooLongMessage('addressStreet', 'A'.repeat(41)), /40/)
  assert.deepEqual(
    collectOverlongFieldPaths({
      passportIssuingCity: 'A'.repeat(25),
      lastNameEnglish: 'A'.repeat(34),
      jobTitle: 'A'.repeat(80),
    }),
    ['lastNameEnglish'],
  )

  assert.equal(
    fitDs160Value('Alexander Montgomery Williamson Junior', 33),
    'Alexander Montgomery Williamson',
  )
  assert.equal(fitDs160Phone('+972-50-1234567', 15), '+972-50-1234567')
  assert.equal(fitDs160Phone('972501234567890123', 15), '972501234567890')

  const text = shortenCitiesInTranslatedText([
    'Passport Issuance City: Ramat HaSharon West',
    'Surnames: Alexander Montgomery Williamson Junior',
    'Primary Phone Number: 972501234567890123',
    'Street Address: 1234 Very Long Example Road Apartment Building',
  ].join('\n'))
  assert.match(text, /Passport Issuance City: Ramat HaSharon West/)
  assert.match(text, /Surnames: Alexander Montgomery Williamson\n/)
  assert.match(text, /Primary Phone Number: 972501234567890\n/)
  assert.ok(!/Apartment Building/.test(text))
})

test('portal cities over 20 characters are blocked', () => {
  assert.equal(cityTooLongMessage('תל אביב'), '')
  assert.match(cityTooLongMessage('מועצה אזורית מעלה יוסף'), /20/)
  assert.deepEqual(
    collectOverlongCityPaths({
      birthCity: 'Jerusalem',
      employerCity: 'Maale Gamla regional council',
      educationRecords: [{ city: 'Herzliya' }],
    }),
    ['employerCity'],
  )
})
