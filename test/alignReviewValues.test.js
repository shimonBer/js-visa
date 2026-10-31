import assert from 'node:assert/strict'
import test from 'node:test'

import {
  lockAnswerSheetToReview,
  snapFillValue,
} from '../lib/alignReviewValues.js'

const REVIEW = `
PERSONAL INFORMATION 1
Given Name: ILANIT
Surname: SATAMKER
Date of Birth: 25/03/1974
City of Birth: Beersheba
Primary Phone Number: 972529464983

PREVIOUS EMPLOYMENT
Employer City: Dimona
City: Dimona
Supervisor Surname: DORON
Supervisor Given Name: YIGAL
`

test('answer sheet keeps the review spelling of a name', () => {
  const sheet = lockAnswerSheetToReview({
    personal1: {
      given_names: 'LILANIT',
      surnames: 'SATAMKER',
      date_of_birth: '1974-03-25',
      city_of_birth: 'Beersheba',
    },
    work_previous: {
      supervisor_given_names: 'IGAL',
      supervisor_surname: 'DORON',
      employer_phone: '972529464983',
    },
  }, REVIEW)

  assert.equal(sheet.personal1.given_names, 'ILANIT')
  assert.equal(sheet.personal1.surnames, 'SATAMKER')
  assert.equal(sheet.personal1.date_of_birth, '1974-03-25')
  assert.equal(sheet.personal1.city_of_birth, 'Beersheba')
  assert.equal(sheet.work_previous.supervisor_given_names, 'YIGAL')
  assert.equal(sheet.work_previous.supervisor_surname, 'DORON')
  assert.equal(sheet.work_previous.employer_phone, '972529464983')
})

test('a generic city key is not replaced by a different city', () => {
  const sheet = lockAnswerSheetToReview({
    work_previous: { city: 'Las Vegas' },
  }, REVIEW)

  assert.equal(sheet.work_previous.city, 'Las Vegas')
})

test('a fill action types the review spelling', () => {
  const action = snapFillValue({
    type: 'fill',
    label: 'Previous Employer Supervisor Given Names',
    value: 'IGAL',
  }, REVIEW)

  assert.equal(action.value, 'YIGAL')
})

test('a fill that already matches the review is unchanged', () => {
  const action = snapFillValue({
    type: 'fill',
    label: 'Supervisor Given Name',
    value: 'YIGAL',
  }, REVIEW)

  assert.equal(action.value, 'YIGAL')
})

test('a date fill is not rewritten', () => {
  const action = snapFillValue({
    type: 'fill',
    label: 'Date of Birth',
    value: '25/03/1974',
  }, REVIEW)

  assert.equal(action.value, '25/03/1974')
})
