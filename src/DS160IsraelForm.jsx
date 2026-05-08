import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { saveFormDraftToBrowser, loadFormDraftFromBrowser } from './lib/formStorage.js'
import { postFormToN8n } from './lib/n8nWebhook.js'
import { serializeFormValuesForJson } from './lib/serializeFormPayload.js'
import { firstFile, uploadFormDocumentsToS3 } from './lib/uploadFormDocuments.js'

/** Normalized key: passport digits/letters + ISO date, e.g. 201381722_2026-08-01 */
function buildFormId(passportId, passportDate) {
  const id = String(passportId ?? '').trim().replace(/[^A-Za-z0-9]/g, '')
  const d = String(passportDate ?? '').trim()
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return ''
  return `${id}_${d}`
}

export default function DS160IsraelForm() {
  const { register, watch, handleSubmit, getValues, reset, formState: { errors } } = useForm({
    defaultValues: {
      passportId: '',
      passportDate: '',
      hadPreviousName: 'no',
      isUnder14: 'no',
      hasForeignCitizenship: 'no',
      travelingWithOthers: 'no',
      visitedUSBefore: 'no',
      hadUSVisa: 'no',
      visaIssuedInIsrael: 'yes',
      visaWasCancelled: 'no',
      visaRefused: 'no',
      deniedEntryToUS: 'no',
      illegalStayInUS: 'no',
      appliedForGreenCard: 'no',
      hasSocialSecurityNumber: 'no',
      hasTaxpayerID: 'no',
      hasUSDriversLicense: 'no',
      passportLostOrStolen: 'no',
      hasUSContact: 'no',
      hasCloseRelativesInUS: 'no',
      workedAnotherJobLast5Years: 'no',
      attendedHighSchool: 'no',
      hasAcademicDegree: 'no',
      hasAdditionalAcademicDegree: 'no',
      visitedAbroadLast5Years: 'no',
      servedInMilitary: 'no',
      criminalRecord: 'no',
      interviewLocation: 'tel_aviv',
      languages: [],
    },
  })

  const passportIdWatch = watch('passportId')
  const passportDateWatch = watch('passportDate')
  const formId = useMemo(
    () => buildFormId(passportIdWatch, passportDateWatch),
    [passportIdWatch, passportDateWatch],
  )
  /** localStorage key: stable id when passport+date set, else shared incomplete slot */
  const storageFormId = useMemo(() => formId || 'incomplete', [formId])
  const [asyncFlow, setAsyncFlow] = useState({ phase: 'idle', message: '' })

  function buildN8nBody(event, fid, values, s3Documents) {
    const { data, fileMeta } = serializeFormValuesForJson(values)
    return {
      event,
      formId: fid || null,
      clientTimestamp: new Date().toISOString(),
      schema: 'ds160_israel_form_v1',
      data,
      fileMeta,
      s3Documents,
    }
  }

  const onSubmit = async (data) => {
    const fid = buildFormId(data.passportId, data.passportDate)
    setAsyncFlow({ phase: 'working', message: '' })
    try {
      const uploads = await uploadFormDocumentsToS3(fid || 'unscoped', [
        { name: 'passportScan', file: firstFile(data.passportScan) },
        { name: 'existingVisaScan', file: firstFile(data.existingVisaScan) },
      ])
      const body = buildN8nBody('submit', fid, data, uploads)
      saveFormDraftToBrowser(fid || 'incomplete', { lastEvent: 'submit', ...body })
      try {
        await postFormToN8n('submit', body)
      } catch (e) {
        setAsyncFlow({
          phase: 'error',
          message: `הנתונים נשמרו בדפדפן; השליחה ל-n8n נכשלה: ${e?.message || 'שגיאה'}`,
        })
        return
      }
      setAsyncFlow({ phase: 'idle', message: 'הטופס נשמר בדפדפן ונשלח ל-n8n.' })
      console.log('Submitted to n8n:', body)
    } catch (e) {
      setAsyncFlow({
        phase: 'error',
        message: e?.message || 'שגיאה (כולל אם העלאת קבצים ל-S3 נכשלה)',
      })
    }
  }

  const onSaveDraft = async () => {
    setAsyncFlow({ phase: 'working', message: '' })
    try {
      const values = getValues()
      const fid = buildFormId(values.passportId, values.passportDate)
      const uploads = await uploadFormDocumentsToS3(fid || 'unscoped', [
        { name: 'passportScan', file: firstFile(values.passportScan) },
        { name: 'existingVisaScan', file: firstFile(values.existingVisaScan) },
      ])
      const body = buildN8nBody('draft', fid, values, uploads)
      saveFormDraftToBrowser(fid || 'incomplete', { lastEvent: 'draft', ...body })
      try {
        await postFormToN8n('draft', body)
      } catch (e) {
        setAsyncFlow({
          phase: 'error',
          message: `הנתונים נשמרו בדפדפן; השליחה ל-n8n נכשלה: ${e?.message || 'שגיאה'}`,
        })
        return
      }
      setAsyncFlow({ phase: 'idle', message: 'הטיוטה נשמרה בדפדפן ונשלחה ל-n8n.' })
      console.log('Draft saved locally + sent to n8n:', body)
    } catch (e) {
      setAsyncFlow({
        phase: 'error',
        message: e?.message || 'שגיאה (כולל אם העלאת קבצים ל-S3 נכשלה)',
      })
    }
  }

  const onLoadLocalDraft = () => {
    const snap = loadFormDraftFromBrowser(storageFormId)
    if (!snap?.data || typeof snap.data !== 'object') {
      setAsyncFlow({ phase: 'error', message: 'אין טיוטה שמורה בדפדפן עבור מזהה זה' })
      return
    }
    reset({
      ...snap.data,
      passportScan: undefined,
      existingVisaScan: undefined,
    })
    setAsyncFlow({ phase: 'idle', message: 'טיוטה נטענה מהדפדפן (קבצים יש לבחור מחדש)' })
  }

  const w = {
    hadPreviousName: watch('hadPreviousName'),
    hasForeignCitizenship: watch('hasForeignCitizenship'),
    visitedUSBefore: watch('visitedUSBefore'),
    hadUSVisa: watch('hadUSVisa'),
    visaRefused: watch('visaRefused'),
    deniedEntryToUS: watch('deniedEntryToUS'),
    illegalStayInUS: watch('illegalStayInUS'),
    appliedForGreenCard: watch('appliedForGreenCard'),
    hasSocialSecurityNumber: watch('hasSocialSecurityNumber'),
    hasTaxpayerID: watch('hasTaxpayerID'),
    hasUSDriversLicense: watch('hasUSDriversLicense'),
    passportLostOrStolen: watch('passportLostOrStolen'),
    hasUSContact: watch('hasUSContact'),
    hasCloseRelativesInUS: watch('hasCloseRelativesInUS'),
    currentOccupation: watch('currentOccupation'),
    workedAnotherJobLast5Years: watch('workedAnotherJobLast5Years'),
    attendedHighSchool: watch('attendedHighSchool'),
    hasAcademicDegree: watch('hasAcademicDegree'),
    hasAdditionalAcademicDegree: watch('hasAdditionalAcademicDegree'),
    visitedAbroadLast5Years: watch('visitedAbroadLast5Years'),
    servedInMilitary: watch('servedInMilitary'),
  }

  const Input = ({ label, name, type = 'text', note, hint, placeholder }) => (
    <div className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}</label>
      {note && <span className="text-sm text-gray-500 mb-1">{note}</span>}
      {type === 'textarea' ? (
        <textarea {...register(name)} className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500" placeholder={placeholder} rows={3} />
      ) : (
        <input type={type} {...register(name)} className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500" placeholder={placeholder} />
      )}
      {hint && <span className="text-xs text-gray-400 mt-1">{hint}</span>}
      {errors[name] && <span className="text-red-500 text-sm mt-1">{errors[name]?.message || 'שגיאה בשדה'}</span>}
    </div>
  )

  const RadioGroup = ({ label, name, options, note }) => (
    <div className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}</label>
      {note && <span className="text-sm text-gray-500 mb-2">{note}</span>}
      <div className="flex gap-4">
        {options.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
            <input type="radio" value={opt.value} {...register(name)} className="w-4 h-4 text-blue-600" />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
      {errors[name] && <span className="text-red-500 text-sm mt-1">{errors[name]?.message || 'שגיאה בשדה'}</span>}
    </div>
  )

  const Select = ({ label, name, options }) => (
    <div className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}</label>
      <select {...register(name)} className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500">
        <option value="">בחר...</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
      {errors[name] && <span className="text-red-500 text-sm mt-1">{errors[name]?.message || 'שגיאה בשדה'}</span>}
    </div>
  )

  return (
    <div dir="rtl" className="min-h-screen bg-gray-100 py-10 px-4 font-sans text-right">
      <div className="max-w-4xl mx-auto bg-white shadow-xl rounded-xl overflow-hidden">

        <div className="bg-blue-600 text-white p-6">
          <h1 className="text-3xl font-bold">DS160 מותאם לישראל</h1>
          <p className="mt-2 text-blue-100">
            טופס מותאם לישראל. שדות מותנים יוצגו אוטומטית בהתאם לתשובות. מומלץ לשמור טיוטה לעיתים קרובות.
          </p>
          <p className="mt-3 text-sm font-mono bg-blue-700/50 rounded-md px-3 py-2 inline-block" dir="ltr">
            מזהה טופס: {formId || 'לא מוגדר — טיוטה תישמר תחת מפתח כללי בדפדפן'}
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-8 space-y-10">

          <section className="space-y-4 rounded-lg border-2 border-amber-200 bg-amber-50/80 p-4 md:p-6">
            <h2 className="text-2xl font-bold border-b border-amber-300 pb-2 text-gray-800">זיהוי טופס (אופציונלי)</h2>
            <p className="text-sm text-gray-600">
              ניתן להזין מספר דרכון ותאריך (למשל תוקף או הנפקה) כדי ליצור מזהה בפורמט{' '}
              <span className="font-mono" dir="ltr">מספר_YYYY-MM-DD</span>
              . כך הטיוטה בדפדפן ותיקיית S3 (אם מוגדרת) יהיו מסודרים לפי לקוח. בלי מזהה, הטיוטה נשמרת תחת מפתח כללי.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col mb-0">
                <label className="font-semibold mb-1 text-gray-700">
                  מספר דרכון
                </label>
                <input
                  type="text"
                  autoComplete="off"
                  {...register('passportId')}
                  className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                  dir="ltr"
                  placeholder="201381722"
                />
              </div>
              <div className="flex flex-col mb-0">
                <label className="font-semibold mb-1 text-gray-700">
                  תאריך (לזיהוי הטופס)
                </label>
                <input
                  type="date"
                  {...register('passportDate')}
                  className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500"
                  dir="ltr"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-end pt-2">
              <button
                type="button"
                onClick={onLoadLocalDraft}
                disabled={asyncFlow.phase === 'working'}
                className="px-4 py-2 text-sm border border-gray-400 text-gray-700 font-semibold rounded-md hover:bg-white transition disabled:opacity-40"
              >
                טען טיוטה מהדפדפן
              </button>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">שם הלקוח ומידע אישי</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="שם פרטי" name="firstName" />
              <Input label="שם משפחה" name="lastName" />

              <RadioGroup label="במידה והיה שם קודם" name="hadPreviousName" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.hadPreviousName === 'yes' && (
                <Input label="שם קודם (הקלד)" name="previousNameValue" />
              )}

              <RadioGroup label="מין" name="sex" options={[{ label: 'זכר', value: 'male' }, { label: 'נקבה', value: 'female' }]} />
              <Select label="סטטוס" name="maritalStatus" options={['רווק', 'נשוי', 'גרוש', 'אלמן', 'נשוי אזרחית', 'פרוד', 'חיים משותפים']} />

              <div className="flex flex-col mb-4">
                <label className="font-semibold mb-1 text-gray-700">תאריך לידה</label>
                <div className="flex gap-2">
                  <input type="text" {...register('birthDateDay')} placeholder="יום" className="border border-gray-300 rounded-md p-2 w-full" />
                  <input type="text" {...register('birthDateMonth')} placeholder="חודש" className="border border-gray-300 rounded-md p-2 w-full" />
                  <input type="text" {...register('birthDateYear')} placeholder="שנה" className="border border-gray-300 rounded-md p-2 w-full" />
                </div>
              </div>

              <RadioGroup label="Are you under 14?" name="isUnder14" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              <Input label="עיר לידה (אם בחו״ל, לציין מדינה)" name="birthCity" />
              <Input label="מספר תעודת הזהות" name="idNumber" />
              <Input label="כתובת מגורים נוכחית - רחוב" name="addressStreet" />
              <Input label="(מספר דירה / apt number)" name="addressApt" />
              <Input label="עיר" name="addressCity" />
              <Input label="טלפון" name="phone" hint="אין מקום לכתוב מקף. Format: 0000000000" />
              <Input label="Email" name="email" type="email" />

              <RadioGroup label="אזרחות זרה?" name="hasForeignCitizenship" options={[{ label: 'לא', value: 'no' }, { label: 'של איזה מדינה?', value: 'yes' }]} />
              {w.hasForeignCitizenship === 'yes' && (
                <Input label="של איזה מדינה (אזרחות זרה)" name="foreignCitizenshipCountry" />
              )}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">תכנון נסיעה לארה&quot;ב</h2>
            <div className="grid grid-cols-1 gap-4">
              <RadioGroup label="האם אתה מתכנן לטוס עם אנשים נוספים?" name="travelingWithOthers" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              <Input label="מתי התכנון לטוס לארה״ב?" name="plannedDepartureDate" />
              <Input label="לכמה זמן?" name="plannedStayDuration" />
              <Input label="איפה תלון בארה״ב?" name="accommodationInUS" type="textarea" />
              <Input label="מי משלם בעבור מגיש הבקשה על הנסיעה?" name="tripFundingSource" />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">ויזה קודמת לארה&quot;ב</h2>
            <div className="grid grid-cols-1 gap-4">
              <RadioGroup label="האם אי פעם ביקרת בארה״ב?" name="visitedUSBefore" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.visitedUSBefore === 'yes' && (
                <Input label="בערך מתי ולכמה זמן [עד 5 אחרונות]" name="previousUSVisits" type="textarea" hint="הפרד שורות, למשל: ינואר 2019 - שבועיים" />
              )}

              <RadioGroup label="הייתה לך בעבר ויזה לארה״ב?" name="hadUSVisa" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.hadUSVisa === 'yes' && (
                <div className="pl-4 border-r-4 border-blue-500 space-y-4 pr-4 bg-gray-50 p-4 rounded">
                  <Input label="תאריך הנפקת הויזה האחרונה" name="lastVisaIssueDate" />
                  <RadioGroup label="האם הויזה הקודמת שלך הונפקה בישראל?" name="visaIssuedInIsrael" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                  <RadioGroup label="האם הויזה שלך בוטלה?" name="visaWasCancelled" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                </div>
              )}

              <RadioGroup label="האם סורבת בעבר לויזה לארה״ב" name="visaRefused" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.visaRefused === 'yes' && <Input label="הסבר מדוע לדעתך, ובאיזה תאריך סורבת לויזה" name="visaRefusalExplanation" type="textarea" />}

              <RadioGroup label="סורבת בעבר כניסה לארה״ב?" name="deniedEntryToUS" options={[{ label: 'לא', value: 'no' }, { label: 'מי איך ומתי', value: 'yes' }]} />
              {w.deniedEntryToUS === 'yes' && <Input label="פרטי סירוב כניסה (מי, איך, מתי)" name="deniedEntryDetails" />}

              <RadioGroup label="האם שהית באופן לא חוקי בארה״ב והפרת את תנאי הויזה?" name="illegalStayInUS" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.illegalStayInUS === 'yes' && <Input label="פרט מדוע שהית באופן לא חוקי" name="illegalStayDetails" />}

              <RadioGroup label="האם בעבר הגשת בקשה לגרין קארד?" name="appliedForGreenCard" options={[{ label: 'לא', value: 'no' }, { label: 'מי איך ומתי', value: 'yes' }]} />
              {w.appliedForGreenCard === 'yes' && <Input label="פרטי בקשת גרין קארד (מי, איך, מתי)" name="greenCardDetails" />}

              <RadioGroup label="U.S. Social Security Number (במידה וביקר בעבר)" name="hasSocialSecurityNumber" options={[{ label: 'לא', value: 'no' }, { label: 'מספר סושיאל', value: 'yes' }]} />
              {w.hasSocialSecurityNumber === 'yes' && <Input label="מספר סושיאל סקוריטי" name="socialSecurityNumber" />}

              <RadioGroup label="U.S. Taxpayer ID Number (במידה וביקר בעבר)" name="hasTaxpayerID" options={[{ label: 'לא', value: 'no' }, { label: 'מה הוא המספר משלם מיסים?', value: 'yes' }]} />
              {w.hasTaxpayerID === 'yes' && <Input label="מספר משלם מיסים אמריקאי" name="taxpayerIDNumber" />}

              <RadioGroup label="היה לך רישיון נהיגה אמריקאי?" name="hasUSDriversLicense" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.hasUSDriversLicense === 'yes' && <Input label="של איזה מדינה ומה המספר רישיון?" name="driversLicenseDetails" type="textarea" />}

              <RadioGroup label="האם אי פעם אבד או נגנב לך הדרכון?" name="passportLostOrStolen" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.passportLostOrStolen === 'yes' && (
                <div className="pl-4 border-r-4 border-blue-500 space-y-4 pr-4 bg-gray-50 p-4 rounded">
                  <Input label="מתי בערך אבד הדרכון?" name="lostPassportWhen" />
                  <Input label="של איזה מדינה הדרכון שאבד?" name="lostPassportCountry" />
                  <Input label="מספר הדרכון שאבד במידה וידוע" name="lostPassportNumber" />
                  <Input label="פרט על אירוע הגניבה / אבדה של הדרכון" name="lostPassportDescription" type="textarea" />
                </div>
              )}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">איש קשר בארה&quot;ב</h2>
            <RadioGroup label="יש לך איש קשר בארה״ב?" name="hasUSContact" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.hasUSContact === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <Select label="קרבת איש הקשר עבורך" name="contactRelationship" options={['קרוב משפחה', 'חבר', 'מעסיק אמריקאי', 'שותף / לקוח עסקי', 'בעל או אישה', 'מוסד לימודים אמריקאי', 'אחר']} />
                <Input label="שם מלא של איש הקשר" name="contactFullName" />
                <Input label="טלפון של איש הקשר" name="contactPhone" />
                <div className="col-span-1 md:col-span-2">
                  <Input label="כתובת מלאה של איש הקשר" name="contactAddress" type="textarea" />
                </div>
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">הורים בני זוג ומשפחה</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="שם האבא" name="fatherFullName" />
              <Input label="תאריך לידה של האבא" name="fatherBirthDate" placeholder="No Date Of Birth for Parent" />
              <Input label="שם האמא" name="motherFullName" />
              <Input label="תאריך לידה של האמא" name="motherBirthDate" placeholder="No Date Of Birth for Parent" />
            </div>

            <RadioGroup label="האם יש לך משפחה מקרבה ראשונה בארה״ב?" name="hasCloseRelativesInUS" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }, { label: 'יש רחוקה', value: 'distant' }]} />

            {w.hasCloseRelativesInUS === 'yes' && (
              <div className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
                <Input label="שם מלא (קרוב משפחה בארה״ב)" name="relativeFullName" />
                <Select label="קרבה אלייך" name="relativeRelationship" options={['הורה', 'אח/ות', 'ילד/ה', 'בעל/אישה']} />
                <Select label="סטטוס בארה״ב" name="relativeUSStatus" options={['גרין קארד (LPR)', 'אזרח', 'אשרת סטודנט', 'אשרת עבודה', 'מטייל', 'אחר']} />
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">עיסוק נוכחי</h2>
            <Select label="עיסוק נוכחי" name="currentOccupation" options={['עובד', 'סטודנט', 'חייל', 'פנסיה', 'מובטל', 'עקר/ת בית']} />

            {w.currentOccupation === 'עובד' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">פרטי עבודה נוכחית</h3>
                <Input label="שם החברה בה עובד" name="employerName" />
                <Input label="כתובת רחוב החברה" name="employerStreet" />
                <Input label="עיר" name="employerCity" />
                <Input label="תפקיד" name="jobTitle" />
                <Input label="טלפון בחברה" name="employerPhone" />
                <Input label="תאריך התחלה" name="employmentStartDate" />
                <Input label="שכר חודשי ברוטו" name="monthlySalaryGross" />
              </div>
            )}

            {w.currentOccupation === 'חייל' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">פרטי שירות צבאי</h3>
                <Input label="בצבא של איזה מדינה?" name="militaryCountry" />
                <Input label="באיזה חייל?" name="militaryBranch" />
                <Input label="תפקיד בצבא" name="militaryRole" />
                <Input label="כתובת הבסיס" name="militaryBaseAddress" />
                <Input label="טלפון ביחידה/מפקד" name="militaryUnitPhone" />
                <Input label="שכר" name="militarySalary" />
                <Input label="דרגה" name="militaryRank" />
                <Input label="תאריך גיוס" name="militaryDraftDate" />
                <Input label="תאריך שחרור" name="militaryDischargeDate" />
              </div>
            )}

            <RadioGroup label="האם עבדת במקום נוסף במסגרת 5 שנים אחרונות?" name="workedAnotherJobLast5Years" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />

            {w.workedAnotherJobLast5Years === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200 mt-4">
                <h3 className="col-span-full font-bold text-lg">עבודה קודמת במסגרת 5 שנים אחרונות</h3>
                <Input label="שם החברה הקודמת" name="prevEmployerName" />
                <Input label="כתובת הרחוב החברה" name="prevEmployerStreet" />
                <Input label="עיר" name="prevEmployerCity" />
                <Input label="תפקיד" name="prevJobTitle" />
                <Input label="שם המנהל" name="prevManagerName" />
                <Input label="טלפון בחברה" name="prevEmployerPhone" />
                <Input label="תאריך התחלה" name="prevEmploymentStartDate" />
                <Input label="תאריך סיום העסקה" name="prevEmploymentEndDate" />
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">לימודים</h2>

            <RadioGroup label="האם למדת בתיכון?" name="attendedHighSchool" options={[{ label: 'לא למדתי בתיכון', value: 'no' }, { label: 'פרט, שם התיכון וכתובת', value: 'yes' }]} />
            {w.attendedHighSchool === 'yes' && <Input label="שם התיכון וכתובת" name="highSchoolDetails" type="textarea" />}

            <RadioGroup label="האם יש תואר אקדמאי?" name="hasAcademicDegree" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.hasAcademicDegree === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">מוסד לימודים 1</h3>
                <Input label="שם מוסד הלימודים" name="institutionName" />
                <Input label="כתובת רחוב" name="institutionStreet" />
                <Input label="עיר" name="institutionCity" />
                <Input label="מה למדת?" name="fieldOfStudy" />
                <Input label="שנת וחודש התחלה" name="studyStartYearMonth" />
                <Input label="שנת וחודש סיום" name="studyEndYearMonth" />

                <div className="col-span-full">
                  <RadioGroup label="האם למדת תואר אקדמי נוסף?" name="hasAdditionalAcademicDegree" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                </div>
              </div>
            )}

            <RadioGroup label="האם ביקרת בחו״ל ב-5 שנים האחרונות?" name="visitedAbroadLast5Years" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.visitedAbroadLast5Years === 'yes' && <Input label="מדינות ב-5 שנים האחרונות" name="countriesVisitedLast5Years" type="textarea" />}

            <RadioGroup label="האם שירתת בצבא?" name="servedInMilitary" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.servedInMilitary === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200 mt-4">
                <h3 className="col-span-full font-bold text-lg">שירות צבאי (היסטוריה)</h3>
                <Input label="לציין אם לא בישראל" name="milHistoryCountry" />
                <Input label="איזה חייל?" name="milHistoryBranch" />
                <Input label="תפקיד" name="milHistoryRole" />
                <Input label="דרגת שחרור" name="milHistoryDischargeRank" />
                <Input label="תאריך גיוס" name="milHistoryDraftDate" />
                <Input label="תאריך שחרור" name="milHistoryDischargeDate" />
              </div>
            )}

            <div className="flex flex-col mb-4">
              <label className="font-semibold mb-2 text-gray-700">שפות</label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {['עברית', 'אנגלית', 'ערבית', 'רוסית', 'ספרדית', 'צרפתית', 'אחר'].map((lang) => (
                  <label key={lang} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" value={lang} {...register('languages')} className="w-4 h-4 text-blue-600 rounded" />
                    <span>{lang}</span>
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">רקע ביטחוני</h2>
            <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded">
              <RadioGroup
                label="Have you ever been arrested and / or do you have a criminal record / a police case?"
                name="criminalRecord"
                options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]}
                note="סופר חשוב: יש לוודא שהלקוח מבין את חשיבות השאלה הזו."
              />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">רשתות חברתיות ומיקום ראיון</h2>
            <Input label="קישורים לרשתות החברתיות" name="socialMediaLinks" type="textarea" />
            <RadioGroup label="לאן תגש לראיון?" name="interviewLocation" options={[
              { label: 'הירקון 71, תל אביב', value: 'tel_aviv' },
              { label: 'דוד פלוסר 14, ירושלים', value: 'jerusalem' },
            ]} />
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">מסמכים</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col mb-4">
                <label className="font-semibold mb-1 text-gray-700">צילום דרכון</label>
                <input type="file" {...register('passportScan')} accept="image/*" className="border border-dashed border-gray-400 rounded-md p-4 bg-gray-50 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
                {errors.passportScan && <span className="text-red-500 text-sm mt-1">{errors.passportScan?.message || 'שגיאה בשדה'}</span>}
              </div>
              <div className="flex flex-col mb-4">
                <label className="font-semibold mb-1 text-gray-700">ויזה קודמת במידה ויש</label>
                <input type="file" {...register('existingVisaScan')} accept="image/*" className="border border-dashed border-gray-400 rounded-md p-4 bg-gray-50 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
              </div>
            </div>
          </section>

          <div className="pt-6 border-t flex flex-col items-end gap-2">
            {asyncFlow.phase === 'working' && (
              <p className="text-sm text-blue-600">שומר במכשיר, מעלה ל-S3 אם הוגדר, שולח ל-n8n…</p>
            )}
            {asyncFlow.phase === 'idle' && asyncFlow.message && (
              <p className="text-sm text-green-700 max-w-xl text-right">{asyncFlow.message}</p>
            )}
            {asyncFlow.phase === 'error' && (
              <p className="text-sm text-red-600 max-w-xl text-right">{asyncFlow.message}</p>
            )}
            <div className="flex justify-end gap-4">
              <button
                type="button"
                disabled={asyncFlow.phase === 'working'}
                onClick={onSaveDraft}
                className="px-6 py-2 border border-blue-600 text-blue-600 font-semibold rounded-md hover:bg-blue-50 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                שמור טיוטה
              </button>
              <button
                type="submit"
                disabled={asyncFlow.phase === 'working'}
                className="px-6 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 transition shadow-md disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
              >
                שלח טופס
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
