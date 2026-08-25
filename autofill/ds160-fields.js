/**
 * DS-160 field registry — one source of truth for the form's real controls.
 *
 * Every entry maps a canonical field id to the actual ASP.NET control ref that
 * extractPageInventory() reports, plus the prose labels a translated document
 * might use for it. Three consumers share this data:
 *
 *   - match-page.js resolves inventory refs to applicant answers
 *   - the translation answer sheet is generated from these ids, so the extractor
 *     and the filler cannot drift apart
 *   - tests assert every ref here still exists in dom-snapshots/
 *
 * Refs are keyed per page because the form reuses control names across pages:
 * both Personal 1 and Spouse render their date of birth as "DOB".
 *
 * Types: 'text' | 'date' | 'enum' | 'country' | 'bool'
 *   country — a large select; options are not enumerated and executeAction
 *             resolves the option text case-insensitively ("Israel" → "ISRAEL")
 */

/** Option lists copied from dom-snapshots; keeps enum answers form-legal. */
const US_STATUS = [
  'U.S. CITIZEN',
  'U.S. LEGAL PERMANENT RESIDENT (LPR)',
  'NONIMMIGRANT',
  "OTHER/I DON'T KNOW",
]

export const DS160_FIELDS = {
  personal1: {
    surnames:                { ref: 'tbxAPP_SURNAME',          type: 'text', label: 'Surnames',                       aliases: ['Surname', 'Surnames'] },
    given_names:             { ref: 'tbxAPP_GIVEN_NAME',        type: 'text', label: 'Given Names',                    aliases: ['Given Name', 'Given Names'] },
    full_name_native:        { ref: 'tbxAPP_FULL_NAME_NATIVE',  type: 'text', label: 'Full Name in Native Alphabet',   aliases: ['Full Name in Native Alphabet'] },
    date_of_birth:           { ref: 'DOB',                      type: 'date', label: 'Date of Birth',                  aliases: ['Date of Birth'] },
    sex:                     { ref: 'ddlAPP_GENDER',            type: 'enum', label: 'Sex',                            aliases: ['Sex', 'Gender'], options: ['MALE', 'FEMALE'] },
    marital_status:          { ref: 'ddlAPP_MARITAL_STATUS',    type: 'enum', label: 'Marital Status',                 aliases: ['Marital Status'], options: ['MARRIED', 'COMMON LAW MARRIAGE', 'CIVIL UNION/DOMESTIC PARTNERSHIP', 'SINGLE', 'WIDOWED', 'DIVORCED', 'LEGALLY SEPARATED', 'OTHER'] },
    city_of_birth:           { ref: 'tbxAPP_POB_CITY',          type: 'text', label: 'City of Birth',                  aliases: ['City of Birth'] },
    state_province_of_birth: { ref: 'tbxAPP_POB_ST_PROVINCE',   type: 'text', label: 'State/Province of Birth',        aliases: ['State/Province of Birth'] },
    country_of_birth:        { ref: 'ddlAPP_POB_CNTRY',         type: 'country', label: 'Country/Region of Birth',     aliases: ['Country / Region of Birth', 'Country/Region of Birth'] },
  },

  personal2: {
    nationality:             { ref: 'ddlAPP_NATL',              type: 'country', label: 'Country/Region of Origin (Nationality)', aliases: ['Country/Region of Origin (Nationality)', 'Nationality'] },
    national_id_number:      { ref: 'tbxAPP_NATIONAL_ID',       type: 'text', label: 'National Identification Number', aliases: ['National Identification Number'] },
    us_social_security_number: { ref: 'tbxAPP_SSN1',            type: 'text', label: 'U.S. Social Security Number',    aliases: ['U.S. Social Security Number'] },
    us_taxpayer_id_number:   { ref: 'tbxAPP_TAX_ID',            type: 'text', label: 'U.S. Taxpayer ID Number',        aliases: ['U.S. Taxpayer ID Number'] },
  },

  address: {
    street_address_line1:    { ref: 'tbxAPP_ADDR_LN1',          type: 'text', label: 'Street Address (Line 1)',        aliases: ['Street Address', 'Street Address (Line 1)'] },
    street_address_line2:    { ref: 'tbxAPP_ADDR_LN2',          type: 'text', label: 'Street Address (Line 2)',        aliases: ['Street Address (Line 2)'] },
    city:                    { ref: 'tbxAPP_ADDR_CITY',         type: 'text', label: 'City',                           aliases: ['City'] },
    state_province:          { ref: 'tbxAPP_ADDR_STATE',        type: 'text', label: 'State/Province',                 aliases: ['State/Province'] },
    postal_code:             { ref: 'tbxAPP_ADDR_POSTAL_CD',    type: 'text', label: 'Postal Zone/ZIP Code',           aliases: ['Postal Zone/ZIP Code'] },
    country:                 { ref: 'ddlCountry',               type: 'country', label: 'Country',                     aliases: ['Country'] },
    primary_phone:           { ref: 'tbxAPP_HOME_TEL',          type: 'text', label: 'Primary Phone Number',           aliases: ['Primary Phone Number'] },
    secondary_phone:         { ref: 'tbxAPP_MOBILE_TEL',        type: 'text', label: 'Secondary Phone Number',         aliases: ['Secondary Phone Number'] },
    work_phone:              { ref: 'tbxAPP_BUS_TEL',           type: 'text', label: 'Work Phone Number',              aliases: ['Work Phone Number'] },
    email:                   { ref: 'tbxAPP_EMAIL_ADDR',        type: 'text', label: 'Email Address',                  aliases: ['Email Address'] },
  },

  passport: {
    document_type:           { ref: 'ddlPPT_TYPE',              type: 'enum', label: 'Passport/Travel Document Type',  aliases: ['Passport/Travel Document Type'], options: ['REGULAR', 'OFFICIAL', 'DIPLOMATIC', 'LAISSEZ-PASSER', 'OTHER'] },
    passport_number:         { ref: 'tbxPPT_NUM',               type: 'text', label: 'Passport/Travel Document Number', aliases: ['Passport Number', 'Passport/Travel Document Number'] },
    passport_book_number:    { ref: 'tbxPPT_BOOK_NUM',          type: 'text', label: 'Passport Book Number',           aliases: ['Passport Book Number'] },
    issuing_country:         { ref: 'ddlPPT_ISSUED_CNTRY',      type: 'country', label: 'Country/Authority that Issued Passport/Travel Document', aliases: ['Country/Authority that Issued Passport/Travel Document', 'Country of Issuance'] },
    issued_in_city:          { ref: 'tbxPPT_ISSUED_IN_CITY',    type: 'text', label: 'Passport Issuance City',         aliases: ['Passport Issuance City', 'City of Issuance'] },
    issued_in_state:         { ref: 'tbxPPT_ISSUED_IN_STATE',   type: 'text', label: 'Passport Issuance State/Province', aliases: ['Passport Issuance State/Province', 'State/Province of Issuance'] },
    issued_in_country:       { ref: 'ddlPPT_ISSUED_IN_CNTRY',   type: 'country', label: 'Passport Issuance Country/Region', aliases: ['Passport Issuance Country/Region'] },
    issuance_date:           { ref: 'PPT_ISSUED_DTE',           type: 'date', label: 'Passport Issuance Date',         aliases: ['Issuance Date', 'Passport Issue Date', 'Passport Issuance Date'] },
    expiration_date:         { ref: 'PPT_EXPIRE_DTE',           type: 'date', label: 'Passport Expiration Date',       aliases: ['Expiration Date', 'Passport Expiration Date'] },
  },

  contact: {
    contact_surnames:        { ref: 'tbxUS_POC_SURNAME',        type: 'text', label: 'Surnames',                       aliases: ['Contact Person Surname'] },
    contact_given_names:     { ref: 'tbxUS_POC_GIVEN_NAME',     type: 'text', label: 'Given Names',                    aliases: ['Contact Person Given Name'] },
    organization_name:       { ref: 'tbxUS_POC_ORGANIZATION',   type: 'text', label: 'Organization Name',              aliases: ['Organization Name'] },
    relationship:            { ref: 'ddlUS_POC_REL_TO_APP',     type: 'enum', label: 'Relationship to You',            aliases: ['Relationship to You'], options: ['RELATIVE', 'SPOUSE', 'FRIEND', 'BUSINESS ASSOCIATE', 'EMPLOYER', 'SCHOOL OFFICIAL', 'OTHER'] },
    street_address_line1:    { ref: 'tbxUS_POC_ADDR_LN1',       type: 'text', label: 'U.S. Street Address (Line 1)',   aliases: ['Street Address'] },
    street_address_line2:    { ref: 'tbxUS_POC_ADDR_LN2',       type: 'text', label: 'U.S. Street Address (Line 2)',   aliases: ['U.S. Street Address (Line 2)'] },
    city:                    { ref: 'tbxUS_POC_ADDR_CITY',      type: 'text', label: 'City',                           aliases: ['City'] },
    state:                   { ref: 'ddlUS_POC_ADDR_STATE',     type: 'country', label: 'State',                       aliases: ['State'] },
    zip_code:                { ref: 'tbxUS_POC_ADDR_POSTAL_CD', type: 'text', label: 'ZIP Code',                       aliases: ['ZIP Code'] },
    phone:                   { ref: 'tbxUS_POC_HOME_TEL',       type: 'text', label: 'Phone Number',                   aliases: ['Phone Number'] },
    email:                   { ref: 'tbxUS_POC_EMAIL_ADDR',     type: 'text', label: 'Email Address',                  aliases: ['Email Address'] },
  },

  family: {
    father_surnames:         { ref: 'tbxFATHER_SURNAME',        type: 'text', label: 'Surnames',                       aliases: ["Father's Surname"] },
    father_given_names:      { ref: 'tbxFATHER_GIVEN_NAME',     type: 'text', label: 'Given Names',                    aliases: ["Father's Given Name"] },
    father_date_of_birth:    { ref: 'FathersDOB',               type: 'date', label: "Father's Date of Birth",         aliases: ["Father's Date of Birth"] },
    father_us_status:        { ref: 'ddlFATHER_US_STATUS',      type: 'enum', label: "Father's Status",                aliases: ["Father's Status"], options: US_STATUS },
    mother_surnames:         { ref: 'tbxMOTHER_SURNAME',        type: 'text', label: 'Surnames',                       aliases: ["Mother's Surname"] },
    mother_given_names:      { ref: 'tbxMOTHER_GIVEN_NAME',     type: 'text', label: 'Given Names',                    aliases: ["Mother's Given Name"] },
    mother_date_of_birth:    { ref: 'MothersDOB',               type: 'date', label: "Mother's Date of Birth",         aliases: ["Mother's Date of Birth"] },
    mother_us_status:        { ref: 'ddlMOTHER_US_STATUS',      type: 'enum', label: "Mother's Status",                aliases: ["Mother's Status"], options: US_STATUS },
    relative_surnames:       { ref: 'tbxUS_REL_SURNAME',        type: 'text', label: 'Surnames',                       aliases: ['Relative Surname'] },
    relative_given_names:    { ref: 'tbxUS_REL_GIVEN_NAME',     type: 'text', label: 'Given Names',                    aliases: ['Relative Given Name'] },
    relative_relationship:   { ref: 'ddlUS_REL_TYPE',           type: 'enum', label: 'Relationship to You',            aliases: ['Relationship'], options: ['SPOUSE', 'FIANCÉ/FIANCÉE', 'CHILD', 'SIBLING'] },
    relative_status:         { ref: 'ddlUS_REL_STATUS',         type: 'enum', label: "Relative's Status",              aliases: ['Relative Status'], options: US_STATUS },
  },

  spouse: {
    spouse_surnames:         { ref: 'tbxSpouseSurname',         type: 'text', label: "Spouse's Surnames",              aliases: ['Spouse Surname'] },
    spouse_given_names:      { ref: 'tbxSpouseGivenName',       type: 'text', label: "Spouse's Given Names",           aliases: ['Spouse Given Name'] },
    spouse_date_of_birth:    { ref: 'DOB',                      type: 'date', label: "Spouse's Date of Birth",         aliases: ['Spouse Date of Birth'] },
    spouse_nationality:      { ref: 'ddlSpouseNatDropDownList', type: 'country', label: "Spouse's Country/Region of Origin (Nationality)", aliases: ['Spouse Nationality'] },
    spouse_city_of_birth:    { ref: 'tbxSpousePOBCity',         type: 'text', label: 'City',                           aliases: ['Spouse City of Birth'] },
    spouse_country_of_birth: { ref: 'ddlSpousePOBCountry',      type: 'country', label: 'Country/Region',              aliases: ['Spouse Country of Birth'] },
    spouse_address_type:     { ref: 'ddlSpouseAddressType',     type: 'enum', label: "Spouse's Address",               aliases: ['Spouse Address'], options: ['Same as Home Address', 'Same as Mailing Address', 'Same as U.S. Contact Address', 'Do Not Know', 'Other (Specify Address)'] },
  },
}

/**
 * Controls that are a field in their own right rather than a gating checkbox:
 * the parents' dates of birth can only be marked unknown via these, so an "N/A"
 * answer for the date resolves here.
 */
export const DS160_UNKNOWN_CHECKBOXES = {
  family: {
    father_date_of_birth: 'cbxFATHER_DOB_UNK_IND',
    mother_date_of_birth: 'cbxMOTHER_DOB_UNK_IND',
  },
}

/** Page contexts covered by the registry. */
export const REGISTERED_PAGES = Object.keys(DS160_FIELDS)

const indexCache = new Map()

/**
 * Index a page's registry by control ref, with the repeater infix removed so
 * every row of a repeated control resolves to the same entry.
 *
 * @param {string} pageContext
 * @returns {Map<string, {id: string, ref: string, type: string, label: string, aliases: string[], options?: string[]}>}
 */
export function fieldsByRef(pageContext) {
  if (indexCache.has(pageContext)) return indexCache.get(pageContext)

  const index = new Map()
  for (const [id, entry] of Object.entries(DS160_FIELDS[pageContext] || {})) {
    index.set(entry.ref, { id, ...entry })
  }
  indexCache.set(pageContext, index)
  return index
}

/**
 * Answers that mean "leave it blank, or tick Does Not Apply" and must never be
 * written into a field. The DS-160 validates its inputs, so a literal "N/A" in
 * the ZIP box comes back as "ZIP Code is invalid", fails the page, and leaves
 * the agent re-planning the same step until its budget is gone.
 *
 * A bare "No" is deliberately absent: it is a real surname, and this guard also
 * covers name fields. Yes/No answers arrive as radio actions, not as fills.
 */
const FILL_MARKER_RE = new RegExp(
  '^(?:' + [
    'n\\.?/?a\\.?',                                  // N/A, NA, n.a.
    'none', 'nil', 'null', 'nothing', 'tbd',
    'unknown', 'irrelevant', 'n\\.?r\\.?',
    'not\\s+(?:relevant|applicable|available|provided|specified|known|listed|given)',
    'do(?:es)?\\s*n(?:o|\')?t\\s*(?:apply|know)',    // does not apply, doesn't know
    'check\\s+does\\s+not\\s+apply',                 // source cells that say to tick the box
    '(?:leave|left|leaves)\\s+(?:it\\s+)?blank', 'blank', 'empty',
    'no\\s+(?:value|data|answer|info(?:rmation)?)',
    'missing',
    '[-–—?]+',
  ].join('|') + ')$',
  'i',
)

/**
 * Strip the decoration source documents wrap these answers in, so that
 * `*(leave blank)*` and `✅ Check "Does Not Apply"` are recognized as the same
 * instruction as a plain "N/A".
 */
function bareValue(value) {
  return String(value)
    .replace(/[\u2705\u274C\u2757\u2714\u2611\uFE0F\u2049]/g, ' ')
    .replace(/[*_`~]/g, '')
    // Quotes are dropped wherever they sit, not just at the ends: the phrasing
    // these documents use is `Check "Does Not Apply"`, where they are interior.
    .replace(/["'\u2018\u2019\u201C\u201D]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[([]+|[)\].,;:]+$/g, '')
    .trim()
}

/**
 * True when a value must not be written into a field — either because it is
 * absent or because it is one of the "not applicable" phrasings above.
 */
export function isMarkerValue(value) {
  if (value === null || value === undefined) return true
  const bare = bareValue(value)
  return bare === '' || FILL_MARKER_RE.test(bare)
}

/** Page sections the answer sheet carries that the registry does not yet cover. */
const FREEFORM_SECTIONS = [
  'travel', 'companions', 'prev_travel',
  'work_present', 'work_previous', 'work_additional', 'security',
]

/**
 * JSON schema for the translation answer sheet, generated from the registry so
 * the extractor and the filler cannot describe different fields.
 *
 * Registered pages get typed, named properties; the rest stay free-form until
 * they are mapped, which is why this runs with strict:false.
 */
export function answerSheetSchema() {
  const properties = {}

  for (const [pageContext, fields] of Object.entries(DS160_FIELDS)) {
    const pageProps = {}
    for (const [id, entry] of Object.entries(fields)) {
      // null is always allowed and is how "not applicable" is stated, so that an
      // absent answer is never confused with an unanswered one.
      const property = { type: ['string', 'null'], description: entry.label }
      if (entry.type === 'date') {
        property.description = `${entry.label} — ISO date, YYYY-MM-DD`
      } else if (entry.type === 'enum') {
        property.enum = [...entry.options, null]
      } else if (entry.type === 'country') {
        property.description = `${entry.label} — full country or state name in English`
      }
      pageProps[id] = property
    }
    properties[pageContext] = {
      type: 'object',
      properties: pageProps,
      additionalProperties: false,
    }
  }

  for (const section of FREEFORM_SECTIONS) {
    if (!properties[section]) properties[section] = { type: 'object', additionalProperties: true }
  }

  return { type: 'object', properties, additionalProperties: true }
}

/**
 * The registry rendered as prompt text, so the extractor is told the exact key
 * to use for every field rather than inventing one per document.
 */
export function fieldCatalogue() {
  const lines = []
  for (const [pageContext, fields] of Object.entries(DS160_FIELDS)) {
    lines.push(`${pageContext}:`)
    for (const [id, entry] of Object.entries(fields)) {
      let hint = entry.label
      if (entry.type === 'date') hint += ' (YYYY-MM-DD)'
      else if (entry.type === 'enum') hint += ` (one of: ${entry.options.join(' | ')})`
      else if (entry.type === 'country') hint += ' (full English name)'
      lines.push(`  ${id} — ${hint}`)
    }
  }
  return lines.join('\n')
}

/** Strip the ASP.NET repeater infix: dlUSRelatives_ctl00_tbxX → tbxX. */
export function controlName(ref) {
  const text = String(ref ?? '')
  const match = text.match(/(?:^|_)ctl\d+_(.+)$/)
  return match ? match[1] : text
}
