/**
 * Registry of copyable form sections.
 * Add new section ids here, then wire CopyFromFormButton / SectionCopyHeader with that sectionId.
 *
 * Note: "מידע אישי" (personal) is intentionally not copyable.
 */

/** @typedef {{ id: string, label: string, fields: string[] }} CopyableSection */

/** @type {Record<string, CopyableSection>} */
export const COPYABLE_SECTIONS = {
  address: {
    id: 'address',
    label: 'כתובת מגורים',
    fields: [
      'addressStreet',
      'addressStreet2',
      'addressCity',
      'addressState',
      'addressZip',
      'addressCountry',
      'mailingAddressSame',
      'mailingStreet',
      'mailingStreet2',
      'mailingCity',
      'mailingState',
      'mailingZip',
      'mailingCountry',
    ],
  },

  contact: {
    id: 'contact',
    label: 'טלפון ואימייל',
    fields: [
      'phoneCountryCode',
      'phoneNumber',
      'workPhone',
      'otherPhonesLastFiveYears',
      'otherPhones',
      'email',
      'otherEmailsLastFiveYears',
      'otherEmails',
    ],
  },

  travel: {
    id: 'travel',
    label: 'תכנון נסיעה לארה״ב',
    fields: [
      'visaClass',
      'specificTravelPlans',
      'plannedArrivalDate',
      'arrivalFlight',
      'arrivalFlightNA',
      'arrivalCity',
      'departureDateUS',
      'departureFlight',
      'departureFlightNA',
      'departureCity',
      'plannedStayValue',
      'plannedStayUnit',
      'locationsToVisit',
      // accommodation (also available as its own subsection)
      'hasExactAccommodationAddress',
      'accommodationCityPreset',
      'accommodationStreet1',
      'accommodationStreet2',
      'accommodationCity',
      'accommodationState',
      'accommodationStateNA',
      'accommodationZip',
      'accommodationZipNA',
      // payer
      'tripPayerType',
      'tripPayerSurname',
      'tripPayerGivenName',
      'tripPayerPhone',
      'tripPayerEmail',
      'tripPayerEmailNA',
      'tripPayerRelationship',
      'tripPayerSameAddress',
      'tripPayerAddressStreet1',
      'tripPayerAddressStreet2',
      'tripPayerAddressCity',
      'tripPayerAddressState',
      'tripPayerAddressStateNA',
      'tripPayerAddressZip',
      'tripPayerAddressZipNA',
      'tripPayerAddressCountry',
      'tripPayerOrgName',
      'tripPayerOrgRelationship',
      'selfPaying',
      'tripPayerFullName',
      'tripPayerStreet',
      'tripPayerCity',
      'tripPayerCountry',
      // companions
      'travelingWithOthers',
      'travelingAsGroup',
      'travelGroupName',
      'travelCompanions',
    ],
  },

  accommodation: {
    id: 'accommodation',
    label: 'כתובת לינה בארה״ב',
    fields: [
      'hasExactAccommodationAddress',
      'accommodationCityPreset',
      'accommodationStreet1',
      'accommodationStreet2',
      'accommodationCity',
      'accommodationState',
      'accommodationStateNA',
      'accommodationZip',
      'accommodationZipNA',
    ],
  },

  priorVisits: {
    id: 'priorVisits',
    label: 'ביקורים קודמים בארה״ב',
    fields: [
      'visitedUSBefore',
      'previousUSVisits',
      'hasESTAPermit',
      'hasUSDriversLicense',
      'usDriversLicenses',
      'hadUSVisa',
      'lastVisaIssueDate',
      'lastVisaExpirationDate',
      'visaIssuedInIsrael',
      'sameVisaType',
      'visaNumber',
      'visaNumberDoNotKnow',
      'visaNoCopyAvailable',
      'visaWasCancelled',
      'visaWasCancelledExplanation',
      'visaLostOrStolen',
      'visaLostOrStolenYear',
      'visaLostOrStolenExplanation',
      'tenPrinted',
      'refusedOrDeniedUS',
      'refusedOrDeniedExplanation',
      'immigrantPetition',
      'immigrantPetitionExplanation',
    ],
  },

  usContact: {
    id: 'usContact',
    label: 'איש קשר בארה״ב',
    fields: [
      'hasUSContact',
      'contactSurnames',
      'contactGivenNames',
      'contactNameDoNotKnow',
      'contactOrganization',
      'contactOrganizationDoNotKnow',
      'contactRelationship',
      'contactStreet',
      'contactStreet2',
      'contactCity',
      'contactState',
      'contactZip',
      'contactZipNA',
      'contactPhone',
      'contactEmail',
      'contactEmailDoesNotApply',
    ],
  },

  family: {
    id: 'family',
    label: 'מידע משפחתי: קרובים',
    fields: [
      'fatherSurnames',
      'fatherSurnamesDoNotKnow',
      'fatherGivenNames',
      'fatherGivenNamesDoNotKnow',
      'fatherBirthDate',
      'fatherBirthDateDoNotKnow',
      'fatherInUS',
      'fatherUSStatus',
      'motherSurnames',
      'motherSurnamesDoNotKnow',
      'motherGivenNames',
      'motherGivenNamesDoNotKnow',
      'motherBirthDate',
      'motherBirthDateDoNotKnow',
      'motherInUS',
      'motherUSStatus',
      'hasCloseRelativesInUS',
      'hasOtherRelativesInUS',
      'usRelatives',
    ],
  },

  employment: {
    id: 'employment',
    label: 'תעסוקה / השכלה / הכשרה נוכחית',
    fields: [
      'currentOccupation',
      'employerName',
      'employerStreet',
      'employerStreet2',
      'employerCity',
      'employerState',
      'employerStateDoesNotApply',
      'employerZip',
      'employerZipDoesNotApply',
      'employerPhone',
      'employerCountry',
      'jobTitle',
      'employmentStartDate',
      'monthlySalaryGross',
      'monthlySalaryDoesNotApply',
      'jobDuties',
      'studentInstitutionName',
      'studentDegree',
      'studentStartDate',
      'studentInstitutionPhone',
      'studentInstitutionStreet',
      'studentInstitutionCity',
      'studentMonthlyIncome',
      'studentMonthlyIncomeNA',
      'unemploymentReason',
      'unemploymentReasonNA',
      'workedAnotherJobLast5Years',
      'previousEmployments',
    ],
  },

  education: {
    id: 'education',
    label: 'השכלה',
    fields: [
      'hasEducation',
      'educationRecords',
      'attendedHighSchool',
      'hasAcademicDegree',
      'additionalDegrees',
      'hasClanOrTribe',
      'clanOrTribeName',
      'languagesList',
      'visitedAbroadLast5Years',
      'countriesVisited',
      'hasOrganizations',
      'organizations',
      'hasSpecializedSkills',
      'specializedSkillsDescription',
      'servedInMilitary',
      'militaryService',
      'militaryCountry',
      'militaryBranch',
      'militaryRole',
      'hasParamilitary',
      'paramilitaryExplanation',
    ],
  },

  security: {
    id: 'security',
    label: 'Security and Background',
    fields: [
      'arrestedOrConvicted',
      'arrestedOrConvictedExplanation',
      'illegalStayInUS',
      'communicableDisease',
      'communicableDiseaseExplanation',
      'mentalDisorder',
      'mentalDisorderExplanation',
      'drugAbuser',
      'drugAbuserExplanation',
      'violatedControlledSubstances',
      'violatedControlledSubstancesExplanation',
      'engagedInProstitution',
      'engagedInProstitutionExplanation',
      'moneyLaundering',
      'moneyLaunderingExplanation',
      'humanTrafficking',
      'humanTraffickingExplanation',
      'aidedHumanTrafficking',
      'aidedHumanTraffickingExplanation',
      'spouseOfTrafficker',
      'spouseOfTraffickerExplanation',
      'espionage',
      'espionageExplanation',
      'terroristActivities',
      'terroristActivitiesExplanation',
      'supportedTerrorists',
      'supportedTerroristsExplanation',
      'terroristMember',
      'terroristMemberExplanation',
      'spouseOfTerrorist',
      'spouseOfTerroristExplanation',
      'genocide',
      'genocideExplanation',
      'torture',
      'tortureExplanation',
      'extrajudicialKillings',
      'extrajudicialKillingsExplanation',
      'childSoldiers',
      'childSoldiersExplanation',
      'religiousFreedomViolations',
      'religiousFreedomViolationsExplanation',
      'populationControls',
      'populationControlsExplanation',
      'organTransplantation',
      'organTransplantationExplanation',
      'removalHearing',
      'removalHearingExplanation',
      'immigrationFraud',
      'immigrationFraudExplanation',
      'failedToAttendHearing',
      'failedToAttendHearingExplanation',
      'visaViolation',
      'visaViolationExplanation',
      'deportedFromCountry',
      'deportedFromCountryExplanation',
      'withheldCustody',
      'withheldCustodyExplanation',
      'votedIllegally',
      'votedIllegallyExplanation',
      'renouncedCitizenship',
      'renouncedCitizenshipExplanation',
      'publicSchoolWithoutReimbursement',
      'publicSchoolWithoutReimbursementExplanation',
      'arrestedOrConvicted',
      'arrestedOrConvictedExplanation',
    ],
  },

  social: {
    id: 'social',
    label: 'רשתות חברתיות',
    fields: [
      'hasSocialMedia',
      'socialMediaAccounts',
      'hasWebsiteContent',
      'websiteContentList',
    ],
  },

  interview: {
    id: 'interview',
    label: 'מיקום ראיון',
    fields: ['interviewLocation'],
  },
}

/**
 * Pull section field values from a saved blob payload (`{ data: {...} }` or raw data object).
 * @param {object | null | undefined} payload
 * @param {string} sectionId
 * @returns {Record<string, unknown> | null}
 */
export function extractSectionFromPayload(payload, sectionId) {
  const section = COPYABLE_SECTIONS[sectionId]
  if (!section) return null
  const data =
    payload?.data && typeof payload.data === 'object'
      ? payload.data
      : payload && typeof payload === 'object'
        ? payload
        : null
  if (!data) return null

  /** @type {Record<string, unknown>} */
  const out = {}
  let any = false
  for (const field of section.fields) {
    if (Object.prototype.hasOwnProperty.call(data, field) && data[field] !== undefined) {
      out[field] = data[field]
      any = true
    }
  }
  return any ? out : null
}

/**
 * Apply extracted section values into react-hook-form via setValue.
 * @param {(name: string, value: unknown, opts?: object) => void} setValue
 * @param {Record<string, unknown>} values
 */
export function applySectionValues(setValue, values) {
  if (!values || typeof values !== 'object') return
  for (const [name, value] of Object.entries(values)) {
    setValue(name, value, { shouldDirty: true, shouldValidate: true })
  }
}

function isBlank(v) {
  if (v == null) return true
  if (typeof v === 'string') return !v.trim()
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'boolean') return false
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

/**
 * Human-readable preview lines for a copied section.
 * @param {string} sectionId
 * @param {Record<string, unknown>} values
 * @returns {string[]}
 */
export function previewSectionValues(sectionId, values) {
  if (!values) return []

  if (sectionId === 'accommodation') {
    const lines = []
    if (values.hasExactAccommodationAddress === 'yes') {
      lines.push('כתובת מדויקת: כן')
      const street = [values.accommodationStreet1, values.accommodationStreet2]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .join(', ')
      if (street) lines.push(street)
      const cityLine = [values.accommodationCity, values.accommodationState, values.accommodationZip]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .join(', ')
      if (cityLine) lines.push(cityLine)
    } else if (values.hasExactAccommodationAddress === 'no') {
      lines.push('כתובת מדויקת: לא')
      const cityLine = [values.accommodationCity, values.accommodationState]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .join(', ')
      if (cityLine) lines.push(cityLine)
      else if (values.accommodationCityPreset) {
        lines.push(`עיר: ${String(values.accommodationCityPreset)}`)
      }
    } else {
      lines.push('אין נתוני לינה בטופס שנבחר')
    }
    return lines.length ? lines : ['אין נתוני לינה בטופס שנבחר']
  }

  const filled = Object.entries(values).filter(([, v]) => !isBlank(v))
  if (filled.length === 0) return ['אין נתונים להעתקה בסעיף זה']

  const section = COPYABLE_SECTIONS[sectionId]
  const lines = [`${filled.length} שדות עם ערך יועתקו${section ? ` — ${section.label}` : ''}`]
  for (const [k, v] of filled.slice(0, 6)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: ${v.length} פריטים`)
    } else if (typeof v === 'object') {
      lines.push(`${k}: (אובייקט)`)
    } else {
      const s = String(v)
      lines.push(`${k}: ${s.length > 60 ? `${s.slice(0, 57)}…` : s}`)
    }
  }
  if (filled.length > 6) lines.push(`…ועוד ${filled.length - 6}`)
  return lines
}
