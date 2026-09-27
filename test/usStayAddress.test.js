import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDs160SourceData } from '../api/translate-form.js'
import { parseApplicantSource } from '../autofill/parse-applicant-source.js'
import {
  splitPackedUsStayInAnswerSheet,
  splitPackedUsStayInTranslatedText,
  splitUsStayAddress,
} from '../lib/usStayAddress.js'

const PACKED = '1217 Bay Park Pl Far Rockaway, NY 11691 United States'

test('a packed stay line splits into street, city, state, and ZIP', () => {
  assert.deepEqual(splitUsStayAddress({ street: PACKED }), {
    street: '1217 Bay Park Pl',
    city: 'Far Rockaway',
    state: 'NY',
    zip: '11691',
  })
  assert.deepEqual(
    splitUsStayAddress({
      street: PACKED,
      city: 'Far Rockaway',
      state: 'NY',
      zip: '11691',
    }),
    {
      street: '1217 Bay Park Pl',
      city: 'Far Rockaway',
      state: 'NY',
      zip: '11691',
    },
  )
  assert.deepEqual(
    splitUsStayAddress({
      street: '2508 Cardamon Avenue, Hollywood, FL 33026, United States',
    }),
    {
      street: '2508 Cardamon Avenue',
      city: 'Hollywood',
      state: 'FL',
      zip: '33026',
    },
  )
  assert.deepEqual(
    splitUsStayAddress({ street: '1217 St Johns Place Brooklyn, NY 11213' }),
    {
      street: '1217 St Johns Place',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11213',
    },
  )
  assert.equal(splitUsStayAddress({ street: 'Hotels', city: 'New York', state: 'NY' }).street, 'Hotels')
})

test('translation prose and answer sheet keep the packed address off the street line', () => {
  const prose = [
    'Address Where You Will Stay in the U.S.:',
    `Street Address (Line 1): ${PACKED}`,
    'Street Address (Line 2): N/A',
    'City: N/A',
    'State: N/A',
    'ZIP Code: N/A',
    '',
    'PERSON/ENTITY PAYING FOR TRIP',
  ].join('\n')
  const rewritten = splitPackedUsStayInTranslatedText(prose)
  assert.match(rewritten, /Street Address \(Line 1\): 1217 Bay Park Pl\n/)
  assert.match(rewritten, /^City: Far Rockaway$/m)
  assert.match(rewritten, /^State: NY$/m)
  assert.match(rewritten, /^ZIP Code: 11691$/m)
  assert.match(rewritten, /PERSON\/ENTITY PAYING FOR TRIP/)

  const sheet = splitPackedUsStayInAnswerSheet({
    travel: {
      stay_address_line1: PACKED,
      stay_city: null,
      stay_state: null,
      stay_zip_code: null,
    },
  })
  assert.equal(sheet.travel.stay_address_line1, '1217 Bay Park Pl')
  assert.equal(sheet.travel.stay_city, 'Far Rockaway')
  assert.equal(sheet.travel.stay_state, 'NY')
  assert.equal(sheet.travel.stay_zip_code, '11691')
})

test('saved translation and form JSON are split before fill', () => {
  const raw = [
    'Address Where You Will Stay in the U.S.:',
    `Street Address (Line 1): ${PACKED}`,
    'City: Far Rockaway',
    'State: NY',
    'ZIP Code: 11691',
    '',
    '━━━ DS160_ANSWER_SHEET ━━━',
    JSON.stringify({
      travel: {
        stay_address_line1: PACKED,
        stay_city: 'Far Rockaway',
        stay_state: 'NY',
        stay_zip_code: '11691',
      },
    }),
  ].join('\n')
  const parsed = parseApplicantSource(raw)
  assert.match(parsed.text, /Street Address \(Line 1\): 1217 Bay Park Pl/)
  assert.doesNotMatch(parsed.text, /Street Address \(Line 1\): 1217 Bay Park Pl Far Rockaway/)
  assert.equal(parsed.answerSheet.travel.stay_address_line1, '1217 Bay Park Pl')

  const normalized = normalizeDs160SourceData({
    accommodationStreet1: PACKED,
    accommodationCity: '',
    accommodationState: '',
    accommodationZip: '',
    accommodationStateNA: true,
    accommodationZipNA: true,
  })
  assert.equal(normalized.accommodationStreet1, '1217 Bay Park Pl')
  assert.equal(normalized.accommodationCity, 'Far Rockaway')
  assert.equal(normalized.accommodationState, 'NY')
  assert.equal(normalized.accommodationZip, '11691')
  assert.equal(normalized.accommodationStateNA, false)
  assert.equal(normalized.accommodationZipNA, false)
})
