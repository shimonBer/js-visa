import assert from 'node:assert/strict'
import test from 'node:test'

import { toHebrewError } from '../src/lib/hebrewError.js'

test('translates OpenAI 429', () => {
  assert.equal(
    toHebrewError('OpenAI request failed (429)'),
    'הבקשה ל-OpenAI נכשלה. יותר מדי בקשות כרגע. נסה שוב בעוד כמה רגעים.',
  )
})

test('keeps Hebrew messages', () => {
  assert.equal(toHebrewError('שגיאת תרגום'), 'שגיאת תרגום')
})

test('translates an English fragment inside a Hebrew sentence', () => {
  assert.equal(
    toHebrewError('שמירה הצליחה, אבל העלאת הקבצים נכשלה: Upload failed (500)'),
    'שמירה הצליחה, אבל העלאת הקבצים נכשלה: העלאת הקובץ נכשלה. תקלה בשרת. נסה שוב.',
  )
})

test('falls back to Hebrew for unknown English', () => {
  assert.equal(toHebrewError('something exploded on the server'), 'אירעה שגיאה. נסה שוב.')
})

test('uses the status code when the English text is unknown', () => {
  assert.equal(toHebrewError('upstream boom (503)'), 'אירעה שגיאה. השירות לא זמין כרגע. נסה שוב בעוד כמה רגעים.')
})
