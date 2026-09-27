import { isMarkerValue } from '../autofill/ds160-fields.js'

const STREET_SUFFIX =
  'Street|Avenue|Boulevard|Place|Drive|Court|Lane|Road|Parkway|Terrace|Circle|Highway|Ave|Blvd|Pkwy|Hwy|Cir|Ter|Ln|Ct|Rd|Dr|St|Pl|Way'

function filled(value) {
  return !isMarkerValue(value)
}

function filledText(value) {
  return filled(value) ? String(value).trim() : ''
}

/**
 * A stay address sometimes arrives as one line:
 * "1217 Bay Park Pl Far Rockaway, NY 11691 United States".
 * CEAC wants the street, city, state, and ZIP in separate fields.
 */
export function splitUsStayAddress({ street = '', city = '', state = '', zip = '' } = {}) {
  let streetText = String(street ?? '').trim()
  let cityText = filledText(city)
  let stateText = filledText(state).toUpperCase()
  let zipText = filledText(zip)

  streetText = streetText.replace(/,?\s*united states(?: of america)?\.?$/i, '').trim()

  const commaForm = streetText.match(
    /^(.+?),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/i,
  )
  if (commaForm) {
    streetText = commaForm[1].trim()
    if (!cityText) cityText = commaForm[2].trim()
    if (!stateText) stateText = commaForm[3].toUpperCase()
    if (!zipText) zipText = commaForm[4]
  } else {
    const stateZip = streetText.match(/^(.+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/i)
    if (stateZip) {
      streetText = stateZip[1].trim()
      if (!stateText) stateText = stateZip[2].toUpperCase()
      if (!zipText) zipText = stateZip[3]
    }
  }

  if (cityText) {
    const boundary = streetText.length - cityText.length
    if (
      boundary > 1 &&
      streetText.slice(boundary).toLowerCase() === cityText.toLowerCase() &&
      /[\s,]/.test(streetText.charAt(boundary - 1))
    ) {
      streetText = streetText.slice(0, boundary).trim().replace(/,\s*$/, '')
    }
  } else {
    const suffix = streetText.match(new RegExp(`^(.+\\b(?:${STREET_SUFFIX})\\.?)\\s+(.+)$`, 'i'))
    if (suffix && /[A-Za-z]/.test(suffix[2])) {
      streetText = suffix[1].trim()
      cityText = suffix[2].trim().replace(/,\s*$/, '')
    }
  }

  return { street: streetText, city: cityText, state: stateText, zip: zipText }
}

function replaceLabeledLine(body, label, value) {
  const pattern = new RegExp(`^(${label}:[ \\t]*).*$`, 'im')
  if (pattern.test(body)) return body.replace(pattern, `$1${value}`)
  return `${body.replace(/\s*$/, '')}\n${label}: ${value}\n`
}

export function splitPackedUsStayInTranslatedText(text) {
  return String(text || '').replace(
    /(Address Where You Will Stay in the U\.S\.:[ \t]*\n)([\s\S]*?)(?=\n\s*(?:PERSON\/ENTITY PAYING|🟦)|$)/i,
    (block, header, body) => {
      const line1 = body.match(/^Street Address \(Line 1\):[ \t]*(.*)$/im)
      if (!line1) return block
      const city = body.match(/^City:[ \t]*(.*)$/im)
      const state = body.match(/^State:[ \t]*(.*)$/im)
      const zip = body.match(/^ZIP Code:[ \t]*(.*)$/im)
      const split = splitUsStayAddress({
        street: line1[1],
        city: city?.[1],
        state: state?.[1],
        zip: zip?.[1],
      })
      if (
        split.street === line1[1].trim() &&
        split.city === filledText(city?.[1]) &&
        split.state === filledText(state?.[1]).toUpperCase() &&
        split.zip === filledText(zip?.[1])
      ) {
        return block
      }
      let next = replaceLabeledLine(body, 'Street Address \\(Line 1\\)', split.street)
      if (split.city) next = replaceLabeledLine(next, 'City', split.city)
      if (split.state) next = replaceLabeledLine(next, 'State', split.state)
      if (split.zip) next = replaceLabeledLine(next, 'ZIP Code', split.zip)
      return header + next
    },
  )
}

function assignIfPresent(target, key, value) {
  if (!value) return false
  if (filledText(target[key]) === value) return false
  target[key] = value
  return true
}

function splitAddressRecord(record, keys) {
  if (!record || typeof record !== 'object') return { record, changed: false }
  const split = splitUsStayAddress({
    street: record[keys.street],
    city: record[keys.city],
    state: record[keys.state],
    zip: record[keys.zip],
  })
  const next = { ...record }
  let changed = false
  changed = assignIfPresent(next, keys.street, split.street) || changed
  changed = assignIfPresent(next, keys.city, split.city) || changed
  changed = assignIfPresent(next, keys.state, split.state) || changed
  changed = assignIfPresent(next, keys.zip, split.zip) || changed
  return { record: changed ? next : record, changed }
}

export function splitPackedUsStayInAnswerSheet(sheet) {
  if (!sheet || typeof sheet !== 'object' || !sheet.travel || typeof sheet.travel !== 'object') {
    return sheet
  }
  const travel = { ...sheet.travel }
  let changed = false

  const flat = splitAddressRecord(travel, {
    street: 'stay_address_line1',
    city: 'stay_city',
    state: 'stay_state',
    zip: 'stay_zip_code',
  })
  if (flat.changed) {
    Object.assign(travel, flat.record)
    changed = true
  }

  const alt = splitAddressRecord(travel, {
    street: 'us_stay_address_line1',
    city: 'us_stay_city',
    state: 'us_stay_state',
    zip: 'us_stay_zip_code',
  })
  if (alt.changed) {
    Object.assign(travel, alt.record)
    changed = true
  }

  if (travel.us_stay_address && typeof travel.us_stay_address === 'object') {
    const nested = splitAddressRecord(travel.us_stay_address, {
      street: 'street_address_line1',
      city: 'city',
      state: 'state',
      zip: 'zip_code',
    })
    if (nested.changed) {
      travel.us_stay_address = nested.record
      changed = true
    }
  }

  return changed ? { ...sheet, travel } : sheet
}

export function splitPackedAccommodationInSourceData(data) {
  if (!data || typeof data !== 'object') return data
  const split = splitUsStayAddress({
    street: data.accommodationStreet1,
    city: data.accommodationCity,
    state: data.accommodationState,
    zip: data.accommodationZip,
  })
  const next = { ...data }
  let changed = false
  if (split.street && split.street !== String(data.accommodationStreet1 || '').trim()) {
    next.accommodationStreet1 = split.street
    changed = true
  }
  if (split.city && filledText(data.accommodationCity) !== split.city) {
    next.accommodationCity = split.city
    changed = true
  }
  if (split.state && filledText(data.accommodationState).toUpperCase() !== split.state) {
    next.accommodationState = split.state
    next.accommodationStateNA = false
    changed = true
  }
  if (split.zip && filledText(data.accommodationZip) !== split.zip) {
    next.accommodationZip = split.zip
    next.accommodationZipNA = false
    changed = true
  }
  return changed ? next : data
}
