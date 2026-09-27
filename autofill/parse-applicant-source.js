import { isMarkerValue } from './ds160-fields.js'
import {
  splitPackedUsStayInAnswerSheet,
  splitPackedUsStayInTranslatedText,
} from '../lib/usStayAddress.js'
import {
  applyMilitarySpecializedSkillsToAnswerSheet,
  applyMilitarySpecializedSkillsToTranslatedText,
} from '../lib/militarySpecializedSkills.js'

export const ANSWER_SHEET_DELIMITER = '━━━ DS160_ANSWER_SHEET ━━━'

/** CEAC requires a U.S. ZIP; office convention when the stay ZIP is unknown. */
export const UNKNOWN_US_STAY_ZIP = '00000'

function hasStayPlace(obj, streetKeys, cityKeys) {
  if (!obj || typeof obj !== 'object') return false
  const filled = (keys) => keys.some((key) => {
    const value = obj[key]
    return value != null && !isMarkerValue(value)
  })
  return filled(streetKeys) || filled(cityKeys)
}

function placeholderZip(value) {
  return value == null || isMarkerValue(value)
}

export function applyUnknownUsStayZipToTranslatedText(text) {
  return String(text || '').replace(
    /(🟦 TRAVEL INFORMATION[\s\S]*?Street Address \(Line 1\):[^\n]+\n(?:Street Address \(Line 2\):[^\n]*\n)?City:[^\n]+\nState:[^\n]+\nZIP Code:\s*)(?:N\/A|DOES NOT APPLY)/i,
    `$1${UNKNOWN_US_STAY_ZIP}`,
  )
}

export function applyUnknownUsStayZipToAnswerSheet(sheet) {
  if (!sheet || typeof sheet !== 'object' || !sheet.travel || typeof sheet.travel !== 'object') {
    return sheet
  }
  const travel = { ...sheet.travel }
  let changed = false

  if (travel.us_stay_address && typeof travel.us_stay_address === 'object') {
    const addr = { ...travel.us_stay_address }
    if (
      hasStayPlace(addr, ['street_address_line1', 'street'], ['city'])
      && placeholderZip(addr.zip_code)
    ) {
      addr.zip_code = UNKNOWN_US_STAY_ZIP
      travel.us_stay_address = addr
      changed = true
    }
  }

  const streetKeys = ['stay_address_line1', 'us_stay_address_line1']
  const cityKeys = ['stay_city', 'us_stay_city']
  for (const zipKey of ['stay_zip_code', 'us_stay_zip_code']) {
    if (hasStayPlace(travel, streetKeys, cityKeys) && placeholderZip(travel[zipKey])) {
      travel[zipKey] = UNKNOWN_US_STAY_ZIP
      changed = true
    }
  }

  return changed ? { ...sheet, travel } : sheet
}

export function parseApplicantSource(raw) {
  const textIn = String(raw ?? '')
  const embeddedFormId = textIn.match(/^#\s*DS160_FORM_ID=([a-zA-Z0-9_-]+)\s*$/m)?.[1] || ''
  const delimIdx = textIn.indexOf(ANSWER_SHEET_DELIMITER)
  const bodyRaw = delimIdx >= 0 ? textIn.slice(0, delimIdx) : textIn
  let text = bodyRaw.replace(/^#\s*DS160_FORM_ID=[^\r\n]+\r?\n?/m, '').trim()

  let answerSheet = null
  let answerSheetError = ''
  if (delimIdx >= 0) {
    const jsonRaw = textIn.slice(delimIdx + ANSWER_SHEET_DELIMITER.length).trim()
    try {
      answerSheet = JSON.parse(jsonRaw)
    } catch (err) {
      answerSheetError = err.message
    }
  }

  text = applyMilitarySpecializedSkillsToTranslatedText(text)
  text = splitPackedUsStayInTranslatedText(text)
  text = applyUnknownUsStayZipToTranslatedText(text)
  answerSheet = applyMilitarySpecializedSkillsToAnswerSheet(answerSheet)
  answerSheet = splitPackedUsStayInAnswerSheet(answerSheet)
  answerSheet = applyUnknownUsStayZipToAnswerSheet(answerSheet)

  return { text, embeddedFormId, answerSheet, answerSheetError }
}
