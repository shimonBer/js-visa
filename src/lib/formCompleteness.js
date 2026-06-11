/**
 * Required field definitions and completeness calculation for DS-160 forms.
 * Field meta includes type/options so MiniFormGuest can render the correct input.
 */

export const FIELD_META = {
  passportId:               { label: 'מספר דרכון',                    type: 'text' },
  passportIssuingCountry:   { label: 'מדינת הנפקת דרכון',             type: 'text' },
  firstName:                { label: 'שם פרטי (עברית)',               type: 'text' },
  lastName:                 { label: 'שם משפחה (עברית)',              type: 'text' },
  firstNameEnglish:         { label: 'שם פרטי (אנגלית)',              type: 'text' },
  lastNameEnglish:          { label: 'שם משפחה (אנגלית)',             type: 'text' },
  sex:                      { label: 'מין',                            type: 'radio', options: ['זכר', 'נקבה'] },
  maritalStatus:            { label: 'מצב משפחתי',                    type: 'select', options: ['רווק/ה', 'נשוי/נשואה', 'גרוש/ה', 'אלמן/ה'] },
  birthDateDay:             { label: 'יום לידה',                      type: 'number' },
  birthDateMonth:           { label: 'חודש לידה',                     type: 'number' },
  birthDateYear:            { label: 'שנת לידה',                      type: 'number' },
  birthCity:                { label: 'עיר לידה',                      type: 'text' },
  idNumber:                 { label: 'מספר תעודת זהות',               type: 'text' },
  addressStreet:            { label: 'רחוב מגורים',                   type: 'text' },
  addressCity:              { label: 'עיר מגורים',                    type: 'text' },
  phoneNumber:              { label: 'מספר טלפון',                    type: 'text' },
  email:                    { label: 'דואר אלקטרוני',                 type: 'email' },
  plannedStayDuration:      { label: 'משך שהייה מתוכנן',             type: 'text' },
  accommodationInUS:        { label: 'מקום לינה בארה״ב',              type: 'text' },
  tripFundingSource:        { label: 'מקור מימון הנסיעה',             type: 'text' },
  fatherFullName:           { label: 'שם מלא של האב',                 type: 'text' },
  motherFullName:           { label: 'שם מלא של האם',                 type: 'text' },
  languages:                { label: 'שפות',                          type: 'text' },
  currentOccupation:        { label: 'עיסוק נוכחי',                   type: 'text' },
  // Conditional
  previousNameValue:        { label: 'שם קודם',                       type: 'text' },
  foreignCitizenshipCountry:{ label: 'מדינת אזרחות נוספת',            type: 'text' },
  foreignCitizenshipId:     { label: 'מספר זהות (אזרחות נוספת)',      type: 'text' },
  previousUSVisits:         { label: 'ביקורים קודמים בארה״ב',         type: 'text' },
  lastVisaIssueDate:        { label: 'תאריך הנפקת ויזה קודמת',        type: 'date' },
  lastVisaExpirationDate:   { label: 'תאריך תפוגת ויזה קודמת',       type: 'date' },
  visaRefusalExplanation:   { label: 'פירוט סירוב ויזה',              type: 'textarea' },
  deniedEntryDetails:       { label: 'פרטי דחיית כניסה',              type: 'textarea' },
  illegalStayDetails:       { label: 'פרטי שהייה בלתי חוקית',        type: 'textarea' },
  greenCardDetails:         { label: 'פרטי בקשת גרין קארד',           type: 'textarea' },
  socialSecurityNumber:     { label: 'מספר ביטוח לאומי אמריקאי',      type: 'text' },
  taxpayerIDNumber:         { label: 'מספר מזהה לצרכי מס',            type: 'text' },
  driversLicenseDetails:    { label: 'פרטי רישיון נהיגה אמריקאי',     type: 'text' },
  lostPassportWhen:         { label: 'מתי אבד / נגנב הדרכון',         type: 'text' },
  lostPassportCountry:      { label: 'מדינה בה אבד / נגנב הדרכון',    type: 'text' },
  lostPassportDescription:  { label: 'תיאור אבדן / גניבת דרכון',      type: 'textarea' },
  contactFullName:          { label: 'שם איש קשר בארה״ב',             type: 'text' },
  contactPhone:             { label: 'טלפון איש קשר בארה״ב',          type: 'text' },
  contactAddress:           { label: 'כתובת איש קשר בארה״ב',         type: 'text' },
  relativeFullName:         { label: 'שם קרוב משפחה בארה״ב',          type: 'text' },
  employerName:             { label: 'שם המעסיק',                     type: 'text' },
  employerStreet:           { label: 'רחוב המעסיק',                   type: 'text' },
  employerCity:             { label: 'עיר המעסיק',                    type: 'text' },
  jobTitle:                 { label: 'תפקיד',                         type: 'text' },
  employerPhone:            { label: 'טלפון המעסיק',                  type: 'text' },
  employmentStartDate:      { label: 'תאריך תחילת עבודה',             type: 'date' },
  militaryCountry:          { label: 'מדינת השירות הצבאי',            type: 'text' },
  militaryBranch:           { label: 'זרוע צבאית',                    type: 'text' },
  militaryRole:             { label: 'תפקיד צבאי',                    type: 'text' },
  prevEmployerName:         { label: 'שם מעסיק קודם',                 type: 'text' },
  prevJobTitle:             { label: 'תפקיד קודם',                    type: 'text' },
  highSchoolDetails:        { label: 'פרטי בית ספר תיכון',            type: 'text' },
  institutionName:          { label: 'שם מוסד אקדמי',                 type: 'text' },
  fieldOfStudy:             { label: 'תחום לימוד',                    type: 'text' },
  countriesVisitedLast5Years:{ label: 'מדינות שביקרת ב-5 שנים האחרונות', type: 'text' },
  milHistoryBranch:         { label: 'זרוע צבאית (היסטוריה)',          type: 'text' },
  milHistoryRole:           { label: 'תפקיד צבאי (היסטוריה)',          type: 'text' },
}

function isEmpty(v) {
  return v == null || String(v).trim() === '' || (Array.isArray(v) && v.length === 0)
}

function miss(missing, field) {
  if (isEmpty(missing._data[field])) {
    const meta = FIELD_META[field] || { label: field, type: 'text' }
    missing._list.push({
      field,
      label: meta.label,
      type: meta.type,
      ...(meta.options ? { options: meta.options } : {}),
    })
  }
}

/**
 * Calculate form completeness based on required DS-160 fields.
 * Mirrors the validateForTranslation logic in DS160IsraelForm.jsx.
 *
 * @param {object} data - The `data` sub-object from the blob payload, or raw form values.
 * @returns {{ isComplete: boolean, missingFields: Array<{field:string, label:string, type:string, options?:string[]}> }}
 */
export function calculateCompleteness(data) {
  const ctx = { _data: data || {}, _list: [] }
  const req = (f) => miss(ctx, f)

  // Always required
  req('passportId')
  req('passportIssuingCountry')
  req('firstName')
  req('lastName')
  req('firstNameEnglish')
  req('lastNameEnglish')
  req('sex')
  req('maritalStatus')
  req('birthDateDay')
  req('birthDateMonth')
  req('birthDateYear')
  req('birthCity')
  req('idNumber')
  req('addressStreet')
  req('addressCity')
  req('phoneNumber')
  req('email')
  req('plannedStayDuration')
  req('accommodationInUS')
  req('tripFundingSource')
  req('fatherFullName')
  req('motherFullName')
  req('languages')
  req('currentOccupation')

  // Conditional
  if (data?.hadPreviousName === 'yes') req('previousNameValue')
  if (data?.hasForeignCitizenship === 'yes') {
    req('foreignCitizenshipCountry')
    req('foreignCitizenshipId')
  }
  if (data?.visitedUSBefore === 'yes') {
    const visits = data.previousUSVisits
    if (!Array.isArray(visits) || visits.every((v) => !String(v?.visit ?? '').trim())) {
      const meta = FIELD_META.previousUSVisits
      ctx._list.push({ field: 'previousUSVisits', label: meta.label, type: meta.type })
    }
  }
  if (data?.hadUSVisa === 'yes') {
    req('lastVisaIssueDate')
    req('lastVisaExpirationDate')
  }
  if (data?.visaRefused === 'yes') req('visaRefusalExplanation')
  if (data?.deniedEntryToUS === 'yes') req('deniedEntryDetails')
  if (data?.illegalStayInUS === 'yes') req('illegalStayDetails')
  if (data?.appliedForGreenCard === 'yes') req('greenCardDetails')
  if (data?.hasSocialSecurityNumber === 'yes') req('socialSecurityNumber')
  if (data?.hasTaxpayerID === 'yes') req('taxpayerIDNumber')
  if (data?.hasUSDriversLicense === 'yes') req('driversLicenseDetails')
  if (data?.passportLostOrStolen === 'yes') {
    req('lostPassportWhen')
    req('lostPassportCountry')
    req('lostPassportDescription')
  }
  if (data?.hasUSContact === 'yes') {
    req('contactFullName')
    req('contactPhone')
    req('contactAddress')
  }
  if (data?.hasCloseRelativesInUS === 'yes') {
    const relatives = data.usRelatives || []
    const hasEntry = relatives.some((r) => String(r?.fullName ?? '').trim())
    if (!hasEntry) {
      const meta = FIELD_META.relativeFullName
      ctx._list.push({ field: 'relativeFullName', label: meta.label, type: meta.type })
    }
  }
  if (data?.currentOccupation === 'עובד') {
    req('employerName')
    req('employerStreet')
    req('employerCity')
    req('jobTitle')
    req('employerPhone')
    req('employmentStartDate')
  }
  if (data?.currentOccupation === 'חייל') {
    req('militaryCountry')
    req('militaryBranch')
    req('militaryRole')
  }
  if (data?.workedAnotherJobLast5Years === 'yes') {
    req('prevEmployerName')
    req('prevJobTitle')
  }
  if (data?.attendedHighSchool === 'yes') req('highSchoolDetails')
  if (data?.hasAcademicDegree === 'yes') {
    req('institutionName')
    req('fieldOfStudy')
  }
  if (data?.visitedAbroadLast5Years === 'yes') req('countriesVisitedLast5Years')
  if (data?.servedInMilitary === 'yes') {
    req('milHistoryBranch')
    req('milHistoryRole')
  }

  return { isComplete: ctx._list.length === 0, missingFields: ctx._list }
}
