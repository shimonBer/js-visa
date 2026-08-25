import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findInstitutionsMissingAddress,
  lookupInstitutionAddress,
  resolveMissingInstitutionAddresses,
  sanitizeStreet,
} from '../lib/institutionAddresses.js'

/** A fetch stand-in that answers with one chat completion body. */
function stubFetch(content, { ok = true, status = 200 } = {}) {
  const calls = []
  const impl = async (url, options) => {
    calls.push(JSON.parse(options.body))
    return {
      ok,
      status,
      json: async () => ({ choices: [{ message: { content } }] }),
    }
  }
  impl.calls = calls
  return impl
}

// ─── Detection ───────────────────────────────────────────────────────────────

test('finds employers and schools whose street address is missing', () => {
  const sheet = {
    work_present: {
      employer_name: 'Liat Gallia Marketing',
      employer_street: 'HaKabaim 11',
      employer_city: 'Ramat Gan',
    },
    work_previous: {
      employers: [{
        employer_name: 'Elbit Systems Ltd',
        employer_street: 'Road 4',
        employer_city: 'Hod HaSharon',
      }],
      schools: [{
        school_name: 'Ort Ironi D',
        school_street: 'N/A',
        school_city: 'Modiin',
        school_country: 'Israel',
      }],
    },
  }

  const missing = findInstitutionsMissingAddress(sheet)
  assert.equal(missing.length, 1)
  assert.equal(missing[0].name, 'Ort Ironi D')
  assert.equal(missing[0].city, 'Modiin')
  assert.equal(missing[0].country, 'Israel')
  assert.equal(missing[0].streetKey, 'school_street')
})

test('treats every "not applicable" phrasing as a missing address', () => {
  for (const value of ['N/A', 'none', 'unknown', 'Not Relevant', '', null, '-',
    '✅ Check "Does Not Apply"', '*(leave blank)*']) {
    const sheet = { s: { school_name: 'X', school_street: value, school_city: 'Y' } }
    assert.equal(
      findInstitutionsMissingAddress(sheet).length, 1,
      `${JSON.stringify(value)} should count as missing`,
    )
  }
})

test('a nameless or already-addressed institution is not a candidate', () => {
  // Street present — nothing to look up.
  assert.equal(findInstitutionsMissingAddress({
    a: { school_name: 'X', school_street: 'Herzl 1', school_city: 'Y' },
  }).length, 0)

  // No name to search for.
  assert.equal(findInstitutionsMissingAddress({
    a: { school_name: 'N/A', school_street: 'N/A', school_city: 'Y' },
  }).length, 0)

  // A second address line missing is not a problem; only line 1 is required.
  assert.equal(findInstitutionsMissingAddress({
    a: {
      school_name: 'X', school_street_line1: 'Herzl 1',
      school_street_line2: '', school_city: 'Y',
    },
  }).length, 0)
})

test('the applicant home address is not mistaken for an institution', () => {
  const sheet = {
    address: {
      street_address_line1: 'N/A',
      city: 'Ramat Gan',
      country: 'Israel',
    },
  }
  // It has a city and a blank street, but no institution name, so there is
  // nothing to search the web for.
  assert.equal(findInstitutionsMissingAddress(sheet).length, 0)
})

// ─── Sanitizing ──────────────────────────────────────────────────────────────

test('street values are trimmed to what the DS-160 accepts', () => {
  // A trailing period is what made CEAC reject "Elbit Systems Ltd.".
  assert.equal(sanitizeStreet('64 Bialik Blvd.'), '64 Bialik Blvd')
  assert.equal(sanitizeStreet('  Emek   Harod 9  '), 'Emek Harod 9')
  assert.equal(sanitizeStreet("Ta'as Sha'ar Si"), "Ta'as Sha'ar Si")
  assert.equal(sanitizeStreet('רחוב הרצל 1'), '1')
  assert.equal(sanitizeStreet('x'.repeat(60)).length, 40)
})

// ─── Lookup ──────────────────────────────────────────────────────────────────

test('a high-confidence result is accepted and cleaned', async () => {
  const fetchImpl = stubFetch(
    '{"street":"Emek Harod 9","postal_code":"7161000",' +
    '"source":"https://modiin.ort.org.il/","confidence":"high"}',
  )
  const found = await lookupInstitutionAddress(
    { name: 'Ort Ironi D', city: 'Modiin', country: 'Israel' },
    'key', { fetchImpl },
  )

  assert.deepEqual(found, {
    street: 'Emek Harod 9',
    postalCode: '7161000',
    source: 'https://modiin.ort.org.il/',
    confidence: 'high',
  })
  // The institution, its city and its country all have to reach the model, or it
  // answers about a same-named place somewhere else.
  assert.match(fetchImpl.calls[0].messages[1].content, /Ort Ironi D, Modiin, Israel/)
})

test('a low-confidence or empty result is refused', async () => {
  for (const content of [
    '{"street":"","postal_code":"","confidence":"low"}',
    '{"street":"Emek Harod 9","confidence":"low"}',
    '{"street":"-","confidence":"high"}',
    '{"street":"12","confidence":"high"}',
    'I could not find that institution.',
  ]) {
    const found = await lookupInstitutionAddress(
      { name: 'Zzqx Academy', city: 'Modiin' }, 'key', { fetchImpl: stubFetch(content) },
    )
    assert.equal(found, null, `should refuse: ${content}`)
  }
})

test('JSON wrapped in prose or a fenced block is still read', async () => {
  const found = await lookupInstitutionAddress(
    { name: 'X', city: 'Y' }, 'key',
    { fetchImpl: stubFetch('Here it is:\n```json\n{"street":"Herzl 1","confidence":"high"}\n```') },
  )
  assert.equal(found.street, 'Herzl 1')
})

// ─── Orchestration ───────────────────────────────────────────────────────────

test('resolved addresses are written into the sheet', async () => {
  const sheet = {
    work_previous: {
      schools: [{ school_name: 'Ort Ironi D', school_street: 'N/A', school_city: 'Modiin' }],
    },
  }
  const result = await resolveMissingInstitutionAddresses(sheet, 'key', {
    fetchImpl: stubFetch('{"street":"Emek Harod 9","postal_code":"7161000","confidence":"high"}'),
  })

  assert.equal(sheet.work_previous.schools[0].school_street, 'Emek Harod 9')
  assert.equal(result.resolved.length, 1)
  assert.equal(result.unresolved.length, 0)
})

test('an unresolved address is reported and the sheet is left untouched', async () => {
  const sheet = { s: { school_name: 'Zzqx Academy', school_street: 'N/A', school_city: 'Modiin' } }
  const result = await resolveMissingInstitutionAddresses(sheet, 'key', {
    fetchImpl: stubFetch('{"street":"","confidence":"low"}'),
  })

  assert.equal(sheet.s.school_street, 'N/A')
  assert.deepEqual(result.resolved, [])
  assert.equal(result.unresolved[0].name, 'Zzqx Academy')
})

test('a lookup failure never breaks the translation', async () => {
  const sheet = { s: { school_name: 'X', school_street: 'N/A', school_city: 'Y' } }
  const failing = async () => { throw new Error('network down') }

  const result = await resolveMissingInstitutionAddresses(sheet, 'key', { fetchImpl: failing })
  assert.equal(result.unresolved.length, 1)
  assert.equal(sheet.s.school_street, 'N/A')
})

test("a postal code the applicant supplied is not overwritten", async () => {
  const sheet = {
    s: {
      school_name: 'X', school_street: 'N/A', school_city: 'Y',
      school_postal_code: null,
    },
  }
  await resolveMissingInstitutionAddresses(sheet, 'key', {
    fetchImpl: stubFetch('{"street":"Herzl 1","postal_code":"7161000","confidence":"high"}'),
  })

  // null is a deliberate "does not apply" from the extractor, so the search
  // result must not replace it — the form has a checkbox for that field.
  assert.equal(sheet.s.school_postal_code, null)
  assert.equal(sheet.s.school_street, 'Herzl 1')
})
