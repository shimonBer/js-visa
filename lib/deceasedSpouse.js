/**
 * Widowed applicants fill a separate DS-160 page (Family Information: Deceased
 * Spouse). The intake form stores that person on deceasedSpouse* fields, which
 * the translation prompt used to drop — "currently married? No" and "ever
 * married? No" then left the CEAC page blank.
 */

const HEBREW_RE = /[\u0590-\u05FF]/

const LETTER = {
  א: 'A', ב: 'B', ג: 'G', ד: 'D', ה: 'H', ו: 'V', ז: 'Z', ח: 'CH',
  ט: 'T', י: 'Y', כ: 'KH', ך: 'KH', ל: 'L', מ: 'M', ם: 'M', נ: 'N', ן: 'N',
  ס: 'S', ע: 'A', פ: 'P', ף: 'F', צ: 'TZ', ץ: 'TZ', ק: 'K', ר: 'R', ש: 'SH', ת: 'T',
}

const CONSONANT = new Set('בגדהזחטכלמנספצקרשתךםןףץ')

const PLACES = new Map([
  ['באר יעקב', 'Beer Yaakov'],
  ['באר יעקוב', 'Beer Yaakov'],
  ['באר שבע', 'Beer Sheva'],
  ['תל אביב', 'Tel Aviv'],
  ['ירושלים', 'Jerusalem'],
  ['חיפה', 'Haifa'],
  ['פתח תקווה', 'Petah Tikva'],
  ['פתח תקוה', 'Petah Tikva'],
  ['ראשון לציון', 'Rishon LeZion'],
  ['נתניה', 'Netanya'],
  ['אשדוד', 'Ashdod'],
  ['בני ברק', 'Bnei Brak'],
  ['חולון', 'Holon'],
  ['רמת גן', 'Ramat Gan'],
  ['אשקלון', 'Ashkelon'],
  ['רחובות', 'Rehovot'],
  ['בת ים', 'Bat Yam'],
  ['הרצליה', 'Herzliya'],
  ['כפר סבא', 'Kfar Saba'],
  ['חדרה', 'Hadera'],
  ['לוד', 'Lod'],
  ['רמלה', 'Ramla'],
  ['נהריה', 'Nahariya'],
  ['עכו', 'Acre'],
  ['צפת', 'Safed'],
  ['טבריה', 'Tiberias'],
  ['אילת', 'Eilat'],
  ['מודיעין', 'Modiin'],
])

export function isWidowedStatus(value) {
  const text = String(value || '').trim()
  return text === 'אלמן' || /^(?:widowed|widow|widower)$/i.test(text)
}

function isIsrael(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/^ישראל(י|ית)?$/.test(text)) return true
  return /^(?:israel|israeli)$/i.test(text)
}

function transliterateToken(token) {
  const chars = [...token]
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    const prev = chars[i - 1] || ''
    const next = chars[i + 1] || ''
    if (c === 'ו') {
      if (next === 'ו') { out += 'V'; i++; continue }
      if (!prev) { out += 'V'; continue }
      out += 'O'
      continue
    }
    if (c === 'י') {
      if (!prev) { out += 'Y'; continue }
      if (next && CONSONANT.has(next)) { out += 'I'; continue }
      out += 'Y'
      continue
    }
    if (c === 'ב') {
      out += !next && prev ? 'V' : 'B'
      continue
    }
    if ((c === 'ה') && !next) { out += 'A'; continue }
    if (c === 'א' || c === 'ע') { out += 'A'; continue }
    out += LETTER[c] || c
  }
  return out
}

function toLatin(value, { name = false } = {}) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (!text) return ''
  if (!HEBREW_RE.test(text)) return name ? text.toUpperCase() : text
  const latin = text.split(' ').map(transliterateToken).join(' ')
  return name ? latin.toUpperCase() : latin
}

function toPlace(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (!text) return ''
  if (PLACES.has(text)) return PLACES.get(text)
  if (!HEBREW_RE.test(text)) return text
  return toLatin(text)
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, boundary, letter) => boundary + letter.toUpperCase())
}

function formatBirthDate(value) {
  const text = String(value || '').trim()
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) return `${dmy[1].padStart(2, '0')}/${dmy[2].padStart(2, '0')}/${dmy[3]}`
  return text
}

function splitFullName(fullName) {
  const latin = toLatin(fullName, { name: true })
  const parts = latin.split(' ').filter(Boolean)
  if (!parts.length) return { givenName: '', surname: '' }
  if (parts.length === 1) return { givenName: 'FNU', surname: parts[0] }
  return { givenName: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] }
}

function parseBirthPlace(raw, citizenship) {
  const text = String(raw || '').trim()
  const israeli = isIsrael(citizenship)
  if (!text) return { city: '', country: israeli ? 'Israel' : '' }
  const chunks = text.split(/\s*[,/;|]\s*|\s+-\s+/).map((part) => part.trim()).filter(Boolean)
  if (chunks.length >= 2 && isIsrael(chunks[chunks.length - 1])) {
    return {
      city: toPlace(chunks.slice(0, -1).join(' ')),
      country: 'Israel',
    }
  }
  if (isIsrael(text)) return { city: '', country: 'Israel' }
  return { city: toPlace(text), country: israeli ? 'Israel' : '' }
}

function lineValue(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(block || '').match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'mi'))?.[1]?.trim() || ''
}

export function parseDeceasedSpouseSection(text) {
  const block = String(text || '').match(/🟦 DECEASED SPOUSE[\s\S]*?(?=\n🟦|$)/i)?.[0] || ''
  return {
    surname: lineValue(block, 'Deceased Spouse Surname'),
    givenName: lineValue(block, 'Deceased Spouse Given Name'),
    birthDate: lineValue(block, 'Deceased Spouse Date of Birth'),
    nationality: lineValue(block, 'Deceased Spouse Nationality'),
    city: lineValue(block, 'Deceased Spouse City of Birth'),
    country: lineValue(block, 'Deceased Spouse Country of Birth'),
  }
}

function deceasedSectionIsUsable(text) {
  const parsed = parseDeceasedSpouseSection(text)
  const block = String(text || '').match(/🟦 DECEASED SPOUSE[\s\S]*?(?=\n🟦|$)/i)?.[0] || ''
  if (!block || HEBREW_RE.test(block)) return false
  if (!parsed.surname || !parsed.givenName || !parsed.birthDate) return false
  if (/missing/i.test(parsed.surname) || /missing/i.test(parsed.givenName)) return false
  return true
}

function buildDeceasedSpouseSection(source) {
  const name = String(source?.deceasedSpouseName || '').trim()
  const birthDate = formatBirthDate(source?.deceasedSpouseBirthDate)
  const citizenship = String(source?.deceasedSpouseCitizenship || '').trim()
  const place = parseBirthPlace(source?.deceasedSpouseBirthCityCountry, citizenship)
  if (!name && !birthDate && !citizenship && !place.city) return ''

  const { givenName, surname } = splitFullName(name)
  const nationality = isIsrael(citizenship) ? 'Israel' : toPlace(citizenship)
  const lines = ['🟦 DECEASED SPOUSE', '']
  if (surname) lines.push(`Deceased Spouse Surname: ${surname}`)
  if (givenName) lines.push(`Deceased Spouse Given Name: ${givenName}`)
  if (birthDate) lines.push(`Deceased Spouse Date of Birth: ${birthDate}`)
  if (nationality) lines.push(`Deceased Spouse Nationality: ${nationality}`)
  if (place.city) lines.push(`Deceased Spouse City of Birth: ${place.city}`)
  if (place.country) lines.push(`Deceased Spouse Country of Birth: ${place.country}`)
  return lines.join('\n')
}

function stripDeceasedSection(text) {
  return String(text || '').replace(/(?:^|\n)🟦 DECEASED SPOUSE[\s\S]*?(?=\n🟦|$)/i, '')
}

function insertSection(text, section) {
  const block = `\n${section}\n`
  if (/\n🟦 PREVIOUS SPOUSES/i.test(text)) {
    return text.replace(/\n🟦 PREVIOUS SPOUSES/i, `${block}\n🟦 PREVIOUS SPOUSES`)
  }
  if (/\n🟦 WORK/i.test(text)) {
    return text.replace(/\n🟦 WORK/i, `${block}\n🟦 WORK`)
  }
  return `${text.replace(/\s*$/, '')}\n\n${section}\n`
}

/**
 * Force Marital Status: Widowed and a Deceased Spouse section into the English
 * review. Keeps a complete Latin section the translator already wrote.
 */
export function applyDeceasedSpouseToTranslatedText(text, source) {
  const body = String(text || '')
  if (!isWidowedStatus(source?.maritalStatus)) return body

  let next = /^Marital Status:/mi.test(body)
    ? body.replace(/^Marital Status:.*$/mi, 'Marital Status: Widowed')
    : body.replace(/^(Sex:.*)$/mi, '$1\nMarital Status: Widowed')
  next = next.replace(/^(Are you currently married\?\s*)Yes\b/gim, '$1No')

  if (deceasedSectionIsUsable(next)) return next

  const section = buildDeceasedSpouseSection(source)
  if (!section) return next
  return insertSection(stripDeceasedSection(next), section).replace(/\n{3,}/g, '\n\n')
}
