import assert from 'node:assert/strict'
import test from 'node:test'

import { autofillSourceText, startLocalAutofill } from '../src/lib/localAutofill.js'

test('autofill source keeps an existing form id header', () => {
  const text = '# DS160_FORM_ID=abc\nSurname: A'
  assert.equal(autofillSourceText(text, 'other'), text)
  assert.equal(autofillSourceText('Surname: A', 'form-1'), '# DS160_FORM_ID=form-1\nSurname: A')
})

test('startLocalAutofill queues the file and presses play', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) })
    if (String(url).endsWith('/api/add-uploads')) {
      return { ok: true, json: async () => ({ added: [{ id: 'run-1', status: 'idle' }] }) }
    }
    return { ok: true, json: async () => ({ queue: [] }) }
  }
  const result = await startLocalAutofill({
    text: 'Surname: BITON',
    formId: 'form-9',
    fileName: 'nira_biton_auto_fill.txt',
    fetchImpl,
    localFill: 'http://127.0.0.1:47821',
  })
  assert.equal(result.started, true)
  assert.equal(result.id, 'run-1')
  assert.equal(result.alreadyRunning, false)
  assert.equal(calls[0].body.files[0].name, 'nira_biton_auto_fill.txt')
  assert.match(calls[0].body.files[0].text, /^# DS160_FORM_ID=form-9/)
  assert.deepEqual(calls[1].body, { id: 'run-1' })
})

test('startLocalAutofill does not play a fill that is already running', async () => {
  let plays = 0
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/play')) plays += 1
    return { ok: true, json: async () => ({ added: [{ id: 'run-2', status: 'filling' }] }) }
  }
  const result = await startLocalAutofill({ text: 'Surname: A', formId: 'f', fetchImpl })
  assert.equal(result.started, true)
  assert.equal(result.alreadyRunning, true)
  assert.equal(plays, 0)
})

test('startLocalAutofill reports offline instead of throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('connect ECONNREFUSED')
  }
  const result = await startLocalAutofill({ text: 'Surname: A', formId: 'f', fetchImpl })
  assert.deepEqual(result, { started: false, reason: 'offline' })
})
