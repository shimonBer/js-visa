import process from 'node:process'

const DEFAULT_I94_MODEL = 'gpt-5.6-sol'

export const I94_MODEL =
  process.env.OPENAI_I94_MODEL?.trim() ||
  process.env.OPENAI_OCR_MODEL?.trim() ||
  DEFAULT_I94_MODEL
