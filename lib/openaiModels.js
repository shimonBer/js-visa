import process from 'node:process'

export const DEFAULT_OCR_MODEL = 'gpt-5.6-sol'
export const DEFAULT_TRANSLATION_MODEL = 'gpt-5.6-terra'
export const DEFAULT_NORMALIZATION_MODEL = DEFAULT_TRANSLATION_MODEL
// Looking up an institution's street address needs live web access, which only
// the search models have. gpt-4o-search-preview is deprecated; this one answers
// through /v1/chat/completions like every other call here.
export const DEFAULT_ADDRESS_LOOKUP_MODEL = 'gpt-5-search-api'

function configuredModel(env, name, fallback) {
  const value = env?.[name]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function resolveOpenAIModels(env = process.env) {
  const ocr = configuredModel(env, 'OPENAI_OCR_MODEL', DEFAULT_OCR_MODEL)
  const translation = configuredModel(
    env,
    'OPENAI_TRANSLATION_MODEL',
    DEFAULT_TRANSLATION_MODEL,
  )

  return {
    ocr,
    translation,
    // Translation and DS-160 normalization happen in the same request.
    normalization: translation,
    autofill: configuredModel(env, 'OPENAI_AUTOFILL_MODEL', ocr),
    addressLookup: configuredModel(
      env,
      'OPENAI_ADDRESS_LOOKUP_MODEL',
      DEFAULT_ADDRESS_LOOKUP_MODEL,
    ),
    i94: configuredModel(env, 'OPENAI_I94_MODEL', ocr),
  }
}

export const OPENAI_MODELS = Object.freeze(resolveOpenAIModels())
