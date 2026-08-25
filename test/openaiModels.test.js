import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_ADDRESS_LOOKUP_MODEL,
  DEFAULT_NORMALIZATION_MODEL,
  DEFAULT_OCR_MODEL,
  DEFAULT_TRANSLATION_MODEL,
  resolveOpenAIModels,
} from '../lib/openaiModels.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('uses the required OCR and translation defaults', () => {
  const models = resolveOpenAIModels({})

  assert.equal(DEFAULT_OCR_MODEL, 'gpt-5.6-sol')
  assert.equal(DEFAULT_TRANSLATION_MODEL, 'gpt-5.6-terra')
  assert.equal(DEFAULT_NORMALIZATION_MODEL, 'gpt-5.6-terra')
  assert.deepEqual(models, {
    ocr: DEFAULT_OCR_MODEL,
    translation: DEFAULT_TRANSLATION_MODEL,
    normalization: DEFAULT_NORMALIZATION_MODEL,
    autofill: DEFAULT_OCR_MODEL,
    i94: DEFAULT_OCR_MODEL,
    addressLookup: DEFAULT_ADDRESS_LOOKUP_MODEL,
  })
})

test('supports trimmed environment overrides', () => {
  const models = resolveOpenAIModels({
    OPENAI_OCR_MODEL: ' custom-ocr ',
    OPENAI_TRANSLATION_MODEL: ' custom-translation ',
    OPENAI_AUTOFILL_MODEL: ' custom-autofill ',
    OPENAI_I94_MODEL: ' custom-i94 ',
    OPENAI_ADDRESS_LOOKUP_MODEL: ' custom-address ',
  })

  assert.deepEqual(models, {
    ocr: 'custom-ocr',
    translation: 'custom-translation',
    normalization: 'custom-translation',
    autofill: 'custom-autofill',
    i94: 'custom-i94',
    addressLookup: 'custom-address',
  })
})

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(entryPath)
    return /\.(?:js|jsx|mjs|cjs)$/.test(entry.name) ? [entryPath] : []
  }))
  return files.flat()
}

test('source code contains no legacy OpenAI model references', async () => {
  const roots = ['api', 'autofill', 'i94-service', 'lib', 'src']
  const files = (await Promise.all(
    roots.map((root) => sourceFiles(path.join(repoRoot, root))),
  )).flat()
  const legacyModels = ['gpt-' + '4.1']

  for (const file of files) {
    const source = (await readFile(file, 'utf8')).toLowerCase()
    assert.doesNotMatch(
      source,
      /temperature\s*:\s*0/,
      `${path.relative(repoRoot, file)} sets an unsupported temperature`,
    )
    for (const model of legacyModels) {
      assert.equal(source.includes(model), false, `${path.relative(repoRoot, file)} references ${model}`)
    }
  }
})
