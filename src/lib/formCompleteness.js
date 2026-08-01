/**
 * Required field definitions and completeness calculation for DS-160 forms.
 * Mirrors validateForTranslation in DS160IsraelForm.jsx — keep in sync.
 */

export const FIELD_META = {
  // Personal
  passportId:               { label: 'מספר דרכון' },
  passportIssuingCountry:   { label: 'מדינת הנפקת דרכון' },
  passportIssuingCity:      { label: 'עיר הנפקת דרכון' },
  passportType:             { label: 'סוג דרכון' },
  passportIssueDate:        { label: 'תאריך הנפקת דרכון' },
  passportExpirationDate:   { label: 'תאריך פקיעת דרכון' },
  firstName:                { label: 'שם פרטי (עברית)' },
  lastName:                 { label: 'שם משפחה (עברית)' },
  firstNameEnglish:         { label: 'שם פרטי (אנגלית)' },
  lastNameEnglish:          { label: 'שם משפחה (אנגלית)' },
  hadPreviousName:          { label: 'שם קודם (כן/לא)' },
  hasTelecode:              { label: 'טלקוד (כן/לא)' },
  sex:                      { label: 'מין' },
  maritalStatus:            { label: 'סטטוס משפחתי' },
  birthDateDay:             { label: 'יום לידה' },
  birthDateMonth:           { label: 'חודש לידה' },
  birthDateYear:            { label: 'שנת לידה' },
  birthCity:                { label: 'עיר לידה' },
  birthCountry:             { label: 'מדינת לידה' },
  nationality:              { label: 'לאום / אזרחות' },
  idNumber:                 { label: 'מספר תעודת זהות' },
  hasForeignCitizenship:    { label: 'אזרחות נוספת (כן/לא)' },
  isPermanentResidentElsewhere: { label: 'תושב קבע במדינה אחרת (כן/לא)' },
  // Address
  addressStreet:            { label: 'רחוב מגורים' },
  addressCity:              { label: 'עיר מגורים' },
  addressCountry:           { label: 'מדינת מגורים' },
  phoneCountryCode:         { label: 'קידומת טלפון' },
  phoneNumber:              { label: 'מספר טלפון' },
  email:                    { label: 'דואר אלקטרוני' },
  // Travel
  specificTravelPlans:      { label: 'תוכניות נסיעה ספציפיות (כן/לא)' },
  plannedArrivalDate:       { label: 'תאריך הגעה לארה״ב' },
  plannedStayValue:         { label: 'משך שהייה מתוכנן' },
  plannedStayUnit:          { label: 'יחידת משך שהייה' },
  departureDateUS:          { label: 'תאריך עזיבה מארה״ב' },
  arrivalCity:              { label: 'עיר הגעה בארה״ב' },
  departureCity:            { label: 'עיר יציאה מארה״ב' },
  accommodationStreet1:     { label: 'כתובת לינה בארה״ב — רחוב (שורה 1)' },
  accommodationCity:        { label: 'כתובת לינה בארה״ב — עיר' },
  tripPayerType:            { label: 'מי משלם את הנסיעה' },
  // Family
  fatherSurnames:           { label: 'שם מלא של האב' },
  motherSurnames:           { label: 'שם מלא של האם' },
  fatherUSStatus:           { label: 'סטטוס האב בארה״ב' },
  motherUSStatus:           { label: 'סטטוס האם בארה״ב' },
  // Languages
  'languagesList.0.name':   { label: 'שפות (לפחות אחת)' },
  // Occupation
  currentOccupation:        { label: 'עיסוק נוכחי' },
  jobTitle:                 { label: 'תפקיד' },
  employerName:             { label: 'שם המעסיק' },
  employerStreet:           { label: 'רחוב המעסיק' },
  employerCity:             { label: 'עיר המעסיק' },
  employerPhone:            { label: 'טלפון המעסיק' },
  employmentStartDate:      { label: 'תאריך תחילת עבודה' },
  militaryCountry:          { label: 'מדינת השירות הצבאי' },
  militaryBranch:           { label: 'זרוע / חיל צבאי' },
  militaryRole:             { label: 'תפקיד צבאי' },
  studentInstitutionName:   { label: 'שם מוסד לימודים' },
  studentDegree:            { label: 'תואר / תחום לימוד' },
  studentStartDate:         { label: 'תאריך תחילת לימודים' },
  studentInstitutionPhone:  { label: 'טלפון מוסד לימודים' },
  studentInstitutionStreet: { label: 'כתובת מוסד לימודים' },
  studentInstitutionCity:   { label: 'עיר מוסד לימודים' },
  // Contact
  'contactSurnames':        { label: 'שם איש קשר בארה״ב' },
  'contactGivenNames':      { label: 'שם פרטי של איש קשר בארה״ב' },
  'contactOrganization':    { label: 'שם ארגון בארה״ב' },
  'contactRelationship':    { label: 'הקשר לאיש הקשר / הארגון' },
  'contactStreet':          { label: 'כתובת איש קשר — רחוב' },
  'contactCity':            { label: 'כתובת איש קשר — עיר' },
  'contactState':           { label: 'כתובת איש קשר — מדינה' },
  'contactZip':             { label: 'מיקוד איש קשר' },
  'contactPhone':           { label: 'טלפון איש קשר / ארגון' },
  'contactEmail':           { label: 'אימייל איש קשר / ארגון' },
  // Education
  'educationRecords.0.institutionName': { label: 'שם מוסד חינוכי' },
  'educationRecords.0.courseOfStudy':   { label: 'תחום לימוד' },
  'educationRecords.0.dateFrom':        { label: 'תאריך תחילת לימודים' },
  'educationRecords.0.dateTo':          { label: 'תאריך סיום לימודים' },
  // Misc
  'locationsToVisit.0.location': { label: 'מקומות לביקור בארה״ב' },
  'countriesVisited.0.country':  { label: 'מדינות שביקרת ב-5 שנים האחרונות' },
}

function isEmpty(v) {
  return v == null || String(v).trim() === ''
}

function getDeep(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

/**
 * Calculate form completeness.
 * Mirrors validateForTranslation in DS160IsraelForm.jsx — keep in sync.
 */
export function calculateCompleteness(data) {
  const list = []
  const d = data || {}

  function req(field) {
    const v = field.includes('.') ? getDeep(d, field) : d[field]
    if (isEmpty(v)) {
      const meta = FIELD_META[field] || { label: field }
      list.push({ field, label: meta.label })
    }
  }

  // ── Personal ──
  req('passportId')
  req('firstName')
  req('lastName')
  req('firstNameEnglish')
  req('lastNameEnglish')
  req('hadPreviousName')
  req('hasTelecode')
  req('sex')
  req('maritalStatus')

  const ms = d.maritalStatus
  if (ms === 'גרוש' || ms === 'פרוד') {
    const formerSpouses = d.formerSpouses || []
    formerSpouses.forEach((fs, i) => {
      if (!String(fs?.surnames ?? '').trim()) list.push({ field: `formerSpouses.${i}.surnames`, label: 'שם משפחה של בן/בת זוג לשעבר' })
      if (!String(fs?.nationality ?? '').trim()) list.push({ field: `formerSpouses.${i}.nationality`, label: 'אזרחות בן/בת זוג לשעבר' })
      if (!fs?.birthCityDoNotKnow && !String(fs?.birthCity ?? '').trim()) list.push({ field: `formerSpouses.${i}.birthCity`, label: 'עיר לידה של בן/בת זוג לשעבר' })
      if (!String(fs?.marriageDate ?? '').trim()) list.push({ field: `formerSpouses.${i}.marriageDate`, label: 'תאריך נישואין (לשעבר)' })
      if (!String(fs?.marriageEndDate ?? '').trim()) list.push({ field: `formerSpouses.${i}.marriageEndDate`, label: 'תאריך סיום נישואין' })
      if (!String(fs?.howEnded ?? '').trim()) list.push({ field: `formerSpouses.${i}.howEnded`, label: 'כיצד הסתיימו הנישואין' })
      if (!String(fs?.terminationCountry ?? '').trim()) list.push({ field: `formerSpouses.${i}.terminationCountry`, label: 'מדינה שבה הסתיימו הנישואין' })
    })
  }
  if (ms === 'אלמן') {
    req('deceasedSpouseName')
    req('deceasedSpouseBirthDate')
    req('deceasedSpouseCitizenship')
    req('deceasedSpouseBirthCityCountry')
  }
  if (ms && ms !== 'רווק' && ms !== 'גרוש' && ms !== 'פרוד' && ms !== 'אלמן') {
    req('spouseSurnames')
    req('spouseNationality')
    req('spouseBirthDateDay')
    req('spouseBirthDateMonth')
    req('spouseBirthDateYear')
    req('spouseAddressType')
  }

  req('birthDateDay')
  req('birthDateMonth')
  req('birthDateYear')
  req('birthCity')
  req('birthCountry')

  // ── Citizenship ──
  req('nationality')
  req('idNumber')
  req('hasForeignCitizenship')
  req('isPermanentResidentElsewhere')

  // ── Passport ──
  req('passportIssuingCountry')
  req('passportIssuingCity')
  req('passportType')
  req('passportIssueDate')
  req('passportExpirationDate')

  // ── Address / Contact ──
  req('addressStreet')
  req('addressCity')
  req('addressCountry')
  req('phoneCountryCode')
  req('phoneNumber')
  req('email')

  // ── Travel ──
  req('specificTravelPlans')
  req('plannedArrivalDate')
  if (d.specificTravelPlans === 'yes') {
    req('departureDateUS')
    req('arrivalCity')
    req('departureCity')
    req('accommodationStreet1')
    req('accommodationCity')
    const locs = d.locationsToVisit || []
    if (!locs.length || locs.every((l) => !String(l?.location || '').trim())) {
      list.push({ field: 'locationsToVisit.0.location', label: 'מקומות לביקור בארה״ב' })
    }
  } else {
    req('plannedStayValue')
    req('plannedStayUnit')
    req('accommodationStreet1')
    req('accommodationCity')
  }

  // ── Trip payer ──
  req('tripPayerType')
  if (d.tripPayerType === 'OTHER_PERSON') {
    req('tripPayerSurname')
    req('tripPayerGivenName')
    req('tripPayerPhone')
    req('tripPayerRelationship')
  }
  if (d.tripPayerType === 'OTHER_COMPANY_ORGANIZATION') {
    req('tripPayerOrgName')
    req('tripPayerPhone')
    req('tripPayerOrgRelationship')
  }

  // ── Family ──
  if (!d.fatherSurnamesDoNotKnow && !String(d.fatherSurnames ?? '').trim() &&
      !d.fatherGivenNamesDoNotKnow && !String(d.fatherGivenNames ?? '').trim()) {
    list.push({ field: 'fatherSurnames', label: 'שם מלא של האב' })
  }
  if (!d.motherSurnamesDoNotKnow && !String(d.motherSurnames ?? '').trim() &&
      !d.motherGivenNamesDoNotKnow && !String(d.motherGivenNames ?? '').trim()) {
    list.push({ field: 'motherSurnames', label: 'שם מלא של האם' })
  }
  if (d.fatherInUS === 'yes') req('fatherUSStatus')
  if (d.motherInUS === 'yes') req('motherUSStatus')

  // ── Languages ──
  const langs = d.languagesList || []
  if (!langs.some((l) => String(l?.name ?? '').trim())) {
    list.push({ field: 'languagesList.0.name', label: 'שפות (לפחות אחת)' })
  }

  // ── Occupation ──
  req('currentOccupation')
  const employedOccupations = ['AGRICULTURE','ARTIST/PERFORMER','BUSINESS','COMMUNICATIONS','COMPUTER SCIENCE','CULINARY/FOOD SERVICES','EDUCATION','ENGINEERING','GOVERNMENT','LEGAL PROFESSION','MEDICAL/HEALTH','NATURAL SCIENCE','PHYSICAL SCIENCES','RELIGIOUS VOCATION','RESEARCH','SOCIAL SCIENCE','OTHER']
  if (employedOccupations.includes(d.currentOccupation)) {
    req('employerName')
    req('employerStreet')
    req('employerCity')
    req('jobTitle')
    req('employerPhone')
    req('employmentStartDate')
  }
  if (d.currentOccupation === 'STUDENT') {
    req('studentInstitutionName')
    req('studentDegree')
    req('studentStartDate')
    req('studentInstitutionPhone')
    req('studentInstitutionStreet')
    req('studentInstitutionCity')
  }
  if (d.currentOccupation === 'MILITARY') {
    req('militaryCountry')
    req('militaryBranch')
    req('militaryRole')
  }

  // ── Previous employment ──
  if (d.workedAnotherJobLast5Years === 'yes') {
    const prevJobs = d.previousEmployments || []
    prevJobs.forEach((job, i) => {
      if (!String(job?.employerName ?? '').trim()) list.push({ field: `previousEmployments.${i}.employerName`, label: `מעסיק קודם #${i + 1} — שם` })
      if (!String(job?.jobTitle ?? '').trim()) list.push({ field: `previousEmployments.${i}.jobTitle`, label: `מעסיק קודם #${i + 1} — תפקיד` })
      if (!String(job?.dateFrom ?? '').trim()) list.push({ field: `previousEmployments.${i}.dateFrom`, label: `מעסיק קודם #${i + 1} — תאריך תחילה` })
    })
  }

  // ── Education ──
  if (d.hasEducation === 'yes') {
    const edRecords = d.educationRecords || []
    edRecords.forEach((ed, i) => {
      if (!String(ed?.institutionName ?? '').trim()) list.push({ field: `educationRecords.${i}.institutionName`, label: `מוסד חינוכי #${i + 1} — שם` })
      if (!String(ed?.courseOfStudy ?? '').trim()) list.push({ field: `educationRecords.${i}.courseOfStudy`, label: `מוסד חינוכי #${i + 1} — תחום לימוד` })
      if (!String(ed?.dateFrom ?? '').trim()) list.push({ field: `educationRecords.${i}.dateFrom`, label: `מוסד חינוכי #${i + 1} — תאריך תחילה` })
      if (!String(ed?.dateTo ?? '').trim()) list.push({ field: `educationRecords.${i}.dateTo`, label: `מוסד חינוכי #${i + 1} — תאריך סיום` })
    })
  }

  // ── Conditional ──
  if (d.hadPreviousName === 'yes') {
    const names = d.previousNames || []
    names.forEach((n, i) => {
      if (!String(n?.given || '').trim() && !String(n?.surname || '').trim()) {
        list.push({ field: `previousNames.${i}.given`, label: 'שם קודם' })
      }
    })
    if (!names.length) list.push({ field: 'previousNames.0.given', label: 'שם קודם' })
  }
  if (d.hasForeignCitizenship === 'yes') {
    const fns = d.foreignNationalities || []
    fns.forEach((fn, i) => {
      if (!String(fn?.country || '').trim()) list.push({ field: `foreignNationalities.${i}.country`, label: 'מדינת אזרחות נוספת' })
    })
    if (!fns.length) list.push({ field: 'foreignNationalities.0.country', label: 'מדינת אזרחות נוספת' })
  }
  if (d.isPermanentResidentElsewhere === 'yes') {
    const prs = d.permanentResidencies || []
    prs.forEach((pr, i) => {
      if (!String(pr?.country || '').trim()) list.push({ field: `permanentResidencies.${i}.country`, label: 'מדינת מגורי קבע' })
    })
  }
  if (d.visitedUSBefore === 'yes') {
    const visits = d.previousUSVisits || []
    if (!visits.length || visits.every((v) => !String(v?.arrivalDate ?? '').trim())) {
      list.push({ field: 'previousUSVisits', label: 'ביקורים קודמים בארה״ב' })
    } else {
      visits.forEach((v, i) => {
        if (!String(v?.arrivalDate ?? '').trim()) list.push({ field: `previousUSVisits.${i}.arrivalDate`, label: `ביקור #${i + 1} — תאריך הגעה` })
      })
    }
  }
  if (d.hadUSVisa === 'yes') {
    if (!d.visaNumberDoNotKnow) req('visaNumber')
    req('lastVisaIssueDate')
    req('sameVisaType')
    req('tenPrinted')
  }
  req('contactRelationship')
  req('contactStreet')
  req('contactCity')
  req('contactState')
  req('contactPhone')
  if (!d.contactEmailDoesNotApply) req('contactEmail')
  const hasContactPerson =
    String(d.contactSurnames ?? '').trim() &&
    String(d.contactGivenNames ?? '').trim()
  const hasContactOrganization = String(d.contactOrganization ?? '').trim()
  if (!hasContactPerson && !hasContactOrganization) {
    list.push({ field: 'contactSurnames', label: 'שם מלא של איש קשר בארה״ב או שם ארגון' })
  }
  if (d.hasCloseRelativesInUS === 'yes') {
    const relatives = d.usRelatives || []
    if (!relatives.some((r) => String(r?.surnames ?? '').trim())) {
      list.push({ field: 'usRelatives.0.surnames', label: 'שם קרוב משפחה בארה״ב' })
    }
  }
  if (d.hasOrganizations === 'yes') {
    const orgs = d.organizations || []
    if (!orgs.length || !String(orgs[0]?.name || '').trim()) {
      list.push({ field: 'organizations.0.name', label: 'שם ארגון' })
    }
  }
  if (d.visitedAbroadLast5Years === 'yes') {
    const countries = d.countriesVisited || []
    if (!countries.some((c) => String(c?.country ?? '').trim())) {
      list.push({ field: 'countriesVisited.0.country', label: 'מדינות שביקרת ב-5 שנים האחרונות' })
    }
  }
  if (d.servedInMilitary === 'yes') {
    const services = d.militaryService || []
    services.forEach((ms, i) => {
      if (!String(ms?.country ?? '').trim()) list.push({ field: `militaryService.${i}.country`, label: `שירות צבאי #${i + 1} — מדינה` })
      if (!String(ms?.branch ?? '').trim()) list.push({ field: `militaryService.${i}.branch`, label: `שירות צבאי #${i + 1} — חיל/זרוע` })
    })
  }
  if (d.hasSocialMedia === 'yes') {
    const accounts = d.socialMediaAccounts || []
    if (!accounts.some((a) => String(a?.platform ?? '').trim())) {
      list.push({ field: 'socialMediaAccounts.0.platform', label: 'פלטפורמת מדיה חברתית' })
    }
  }
  if (d.hasSocialSecurityNumber === 'yes') req('socialSecurityNumber')
  if (d.hasTaxpayerID === 'yes') req('taxpayerIDNumber')

  return { isComplete: list.length === 0, missingFields: list }
}
