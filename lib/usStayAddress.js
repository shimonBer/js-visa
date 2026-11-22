import { isMarkerValue } from '../autofill/ds160-fields.js'

const STREET_SUFFIX =
  'Street|Avenue|Boulevard|Place|Drive|Court|Lane|Road|Parkway|Terrace|Circle|Highway|Ave|Blvd|Pkwy|Hwy|Cir|Ter|Ln|Ct|Rd|Dr|St|Pl|Way'

const STATE_BY_NAME = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'american samoa': 'AS', guam: 'GU',
  'northern mariana islands': 'MP', 'puerto rico': 'PR', 'virgin islands': 'VI',
}

const STATE_CODES = new Set(Object.values(STATE_BY_NAME))

const STATE_RE_SRC = Object.keys(STATE_BY_NAME)
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/ /g, '\\s+'))
  .concat('[A-Za-z]{2}')
  .join('|')

const COUNTRY_RE = /(?:united states(?: of america)?|u\.s\.a\.?|usa)/i

function filled(value) {
  return !isMarkerValue(value)
}

function filledText(value) {
  return filled(value) ? String(value).trim() : ''
}

function stateCode(token) {
  const key = String(token ?? '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
  if (!key) return ''
  if (STATE_BY_NAME[key]) return STATE_BY_NAME[key]
  if (/^[a-z]{2}$/.test(key) && STATE_CODES.has(key.toUpperCase())) return key.toUpperCase()
  return ''
}

/**
 * A building number pasted after the country is still part of the street:
 * "Flamingo Drive ... United States 3495".
 */
function peelTrailingHouseNumber(text) {
  const match = text.match(new RegExp(`^(.*)\\b${COUNTRY_RE.source}\\b\\.?\\s*,?\\s*(\\d{1,6})$`, 'i'))
  if (!match || match[2].length === 5) return { text, number: '' }
  return { text: match[1].replace(/[,\s]+$/, '').trim(), number: match[2] }
}

function takeStateZip(text) {
  const two = text.match(new RegExp(
    `^(.+?),\\s*([^,]+?),\\s*(${STATE_RE_SRC})\\s+(\\d{5}(?:-\\d{4})?)$`,
    'i',
  ))
  if (two && stateCode(two[3])) {
    return { street: two[1].trim(), city: two[2].trim(), state: stateCode(two[3]), zip: two[4] }
  }
  const one = text.match(new RegExp(
    `^(.+?),\\s*(${STATE_RE_SRC})\\s+(\\d{5}(?:-\\d{4})?)$`,
    'i',
  ))
  if (one && stateCode(one[2])) {
    return { street: one[1].trim(), city: '', state: stateCode(one[2]), zip: one[3] }
  }
  return null
}

/**
 * A stay or U.S. contact address sometimes arrives as one line:
 * "1217 Bay Park Pl Far Rockaway, NY 11691 United States"
 * or "Flamingo Drive Macon, Georgia 31206 United States 3495".
 * CEAC wants the street, city, state, and ZIP in separate fields.
 * A city, state, or ZIP already filled in is kept.
 */
export function splitUsStayAddress({ street = '', city = '', state = '', zip = '' } = {}) {
  let streetText = String(street ?? '').replace(/\s+/g, ' ').trim()
  let cityText = filledText(city)
  let stateText = stateCode(filledText(state)) || filledText(state).toUpperCase()
  let zipText = filledText(zip)

  const peeled = peelTrailingHouseNumber(streetText)
  streetText = peeled.text
  streetText = streetText.replace(new RegExp(`,?\\s*\\b${COUNTRY_RE.source}\\b\\.?$`, 'i'), '').trim()

  const parsed = takeStateZip(streetText)
  if (parsed) {
    streetText = parsed.street
    if (!cityText && parsed.city) cityText = parsed.city
    if (!stateText) stateText = parsed.state
    if (!zipText) zipText = parsed.zip
  }

  streetText = streetText.replace(/[,\s]+$/, '').trim()

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

  if (peeled.number && !new RegExp(`\\b${peeled.number}\\b`).test(streetText)) {
    streetText = `${streetText} ${peeled.number}`.trim()
  }

  return { street: streetText, city: cityText, state: stateText, zip: zipText }
}

/** The street line still contains a postal blob the DS-160 box cannot hold. */
export function streetStillPacked(street) {
  const text = String(street || '').trim()
  if (text.length <= 40) return false
  return COUNTRY_RE.test(text) || /\b\d{5}(?:-\d{4})?\b/.test(text)
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

function splitPackedFields(data, keys) {
  if (!data || typeof data !== 'object') return data
  const split = splitUsStayAddress({
    street: data[keys.street],
    city: data[keys.city],
    state: data[keys.state],
    zip: data[keys.zip],
  })
  const next = { ...data }
  let changed = false
  if (split.street && split.street !== String(data[keys.street] || '').trim()) {
    next[keys.street] = split.street
    changed = true
  }
  if (split.city && filledText(data[keys.city]) !== split.city) {
    next[keys.city] = split.city
    changed = true
  }
  if (split.state && filledText(data[keys.state]).toUpperCase() !== split.state) {
    next[keys.state] = split.state
    if (keys.stateNA) next[keys.stateNA] = false
    changed = true
  }
  if (split.zip && filledText(data[keys.zip]) !== split.zip) {
    next[keys.zip] = split.zip
    if (keys.zipNA) next[keys.zipNA] = false
    changed = true
  }
  return changed ? next : data
}

export function splitPackedAccommodationInSourceData(data) {
  return splitPackedFields(data, {
    street: 'accommodationStreet1',
    city: 'accommodationCity',
    state: 'accommodationState',
    stateNA: 'accommodationStateNA',
    zip: 'accommodationZip',
    zipNA: 'accommodationZipNA',
  })
}

export function splitPackedContactInSourceData(data) {
  return splitPackedFields(data, {
    street: 'contactStreet',
    city: 'contactCity',
    state: 'contactState',
    zip: 'contactZip',
    zipNA: 'contactZipNA',
  })
}
