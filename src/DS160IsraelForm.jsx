import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm, useFieldArray } from 'react-hook-form'
import { saveFormDraftToBrowser, loadFormDraftFromBrowser } from './lib/formStorage.js'
import { postFormToN8n } from './lib/n8nWebhook.js'
import { serializeFormValuesForJson } from './lib/serializeFormPayload.js'
import { firstFile, uploadFormDocumentsToS3 } from './lib/uploadFormDocuments.js'
import { buildFormId } from './lib/formId.js'
import { saveFormBlobPayload } from './lib/formBlob.js'
import { extractPassportFieldsFromFile } from './lib/passportOcr.js'
import { fetchI94TravelHistory } from './lib/browserUse.js'
import { translateFormToEnglish } from './lib/translateForm.js'
import {
  buildTranslationFingerprint,
  loadTranslationCache,
  saveTranslationCache,
} from './lib/translationCache.js'
import { restoreS3DocumentsIntoForm } from './lib/restoreFormDocumentsFromS3.js'
import { getS3UploadApiBase } from './lib/uploadFormDocuments.js'
import { sendPdfToMonday } from './lib/monday.js'

/**
 * Larger dashed drop zone; optional callback when a file is set (e.g. passport OCR).
 * Shows chosen filename (RHF + local fallback — native file input cannot show programmatic picks reliably).
 */
function DocumentFileSlot({
  label,
  name,
  register,
  setValue,
  getFieldError,
  accept = 'image/*',
  onFilePicked,
  /** @type {FileList|File|null|undefined} */
  watchedValue,
}) {
  const [dragOver, setDragOver] = useState(false)
  const [pickedFileName, setPickedFileName] = useState('')
  const fieldError = getFieldError(name)
  const reg = register(name)
  const nameFromForm = firstFile(watchedValue)?.name?.trim() || ''
  const displayName = nameFromForm || pickedFileName

  return (
    <div className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}</label>
      <div
        onDragEnter={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(false)
          const f = e.dataTransfer.files?.[0]
          if (!f) return
          const dt = new DataTransfer()
          dt.items.add(f)
          setValue(name, dt.files, { shouldValidate: true, shouldDirty: true })
          setPickedFileName(f.name)
          onFilePicked?.(f)
        }}
        className={`rounded-lg border-2 border-dashed p-6 min-h-[10rem] flex flex-col justify-center transition-colors bg-gray-50 ${
          dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-400'
        }`}
      >
        <input
          type="file"
          {...reg}
          accept={accept}
          onChange={(e) => {
            reg.onChange(e)
            const f = e.target.files?.[0]
            setPickedFileName(f?.name || '')
            if (f) onFilePicked?.(f)
          }}
          className="w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
        />
        <p className="text-xs text-gray-500 mt-3 text-center">גרור קובץ לכאן או בחר מהמכשיר</p>
        {displayName ? (
          <p className="text-xs font-medium text-green-700 mt-2 text-center truncate" title={displayName}>
            נבחר: {displayName}
          </p>
        ) : null}
      </div>
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שגיאה בשדה'}</span>}
    </div>
  )
}

/** Module scope so React does not remount inputs on every parent render (fixes focus loss while typing). */
function FormInput({ label, name, type = 'text', note, hint, placeholder, register, getFieldError }) {
  const fieldError = getFieldError(name)
  return (
    <div className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}</label>
      {note && <span className="text-sm text-gray-500 mb-1">{note}</span>}
      {type === 'textarea' ? (
        <textarea {...register(name)} className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500" placeholder={placeholder} rows={3} />
      ) : (
        <input type={type} {...register(name)} className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500" placeholder={placeholder} />
      )}
      {hint && <span className="text-xs text-gray-400 mt-1">{hint}</span>}
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שגיאה בשדה'}</span>}
    </div>
  )
}

function FormRadioGroup({ label, name, options, note, register, getFieldError }) {
  const fieldError = getFieldError(name)
  return (
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
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שגיאה בשדה'}</span>}
    </div>
  )
}

function FormSelect({ label, name, options, register, getFieldError }) {
  const fieldError = getFieldError(name)
  return (
    <div className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}</label>
      <select {...register(name)} className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500">
        <option value="">בחר...</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שגיאה בשדה'}</span>}
    </div>
  )
}

export default function DS160IsraelForm({
  initialBlob = null,
  initialBlobKey = null,
  onExitToHome = null,
} = {}) {
  /** ISO date (YYYY-MM-DD) when this form session started; used for draft/S3 id, not user-editable. */
  const formStartedDateRef = useRef(new Date().toISOString().slice(0, 10))

  const { register, watch, handleSubmit, getValues, setValue, reset, control, formState: { errors } } = useForm({
    defaultValues: {
      passportId: '',
      passportIssuingCountry: '',
      firstName: '',
      lastName: '',
      firstNameEnglish: '',
      lastNameEnglish: '',
      sex: '',
      hadPreviousName: 'no',
      isUnder14: 'no',
      hasForeignCitizenship: 'no',
      travelingWithOthers: 'no',
      travelCompanions: [{ fullName: '', relation: '' }],
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

  const { fields: travelCompanionFields, append: appendTravelCompanion, remove: removeTravelCompanion } =
    useFieldArray({
      control,
      name: 'travelCompanions',
    })

  const passportIdWatch = watch('passportId')
  const passportScanWatch = watch('passportScan')
  const existingVisaScanWatch = watch('existingVisaScan')
  const socialSecurityScanWatch = watch('socialSecurityScan')
  const americanLicenseScanWatch = watch('americanLicenseScan')
  const formId = useMemo(
    () => buildFormId(passportIdWatch, formStartedDateRef.current),
    [passportIdWatch],
  )
  /** localStorage key: stable id when passport+date set, else shared incomplete slot */
  const storageFormId = useMemo(() => formId || 'incomplete', [formId])
  const [asyncFlow, setAsyncFlow] = useState({ phase: 'idle', message: '' })
  const [passportOcr, setPassportOcr] = useState({ status: 'idle', message: '' })
  const [i94State, setI94State] = useState({ status: 'idle', error: '', data: null })
  const [translateUi, setTranslateUi] = useState({
    open: false,
    text: '',
    loading: false,
    error: '',
    attachmentLabels: /** @type {string[]} */ ([]),
    pdfBase64: '',
  })

  /** Monday.com send from translation modal (server creates item + uploads PDF). */
  const [mondayUi, setMondayUi] = useState({
    loading: false,
    error: '',
    success: false,
    itemId: '',
  })

  useEffect(() => {
    if (!initialBlob?.data || typeof initialBlob.data !== 'object') return
    const { passportDate: _omitBlobPd, ...data } = initialBlob.data
    const companions =
      Array.isArray(data.travelCompanions) && data.travelCompanions.length > 0
        ? data.travelCompanions
        : [{ fullName: '', relation: '' }]
    reset({
      ...data,
      travelCompanions: companions,
      passportScan: undefined,
      existingVisaScan: undefined,
      socialSecurityScan: undefined,
      americanLicenseScan: undefined,
    })
  }, [initialBlobKey, initialBlob, reset])

  useEffect(() => {
    const docs = initialBlob?.s3Documents
    if (!initialBlobKey || !Array.isArray(docs) || docs.length === 0) return undefined
    let cancelled = false
    ;(async () => {
      const { restored, failed } = await restoreS3DocumentsIntoForm(docs, setValue)
      if (cancelled) return
      if (restored > 0) {
        const extra = failed > 0 ? ` (${failed} לא הורדו)` : ''
        setAsyncFlow({ phase: 'idle', message: `שוחזרו ${restored} מסמכים מ-S3${extra}.` })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initialBlobKey, initialBlob, setValue])

  function buildN8nBody(event, fid, values, s3Documents) {
    const { data, fileMeta } = serializeFormValuesForJson(values)
    return {
      event,
      formId: fid || null,
      clientTimestamp: new Date().toISOString(),
      schema: 'ds160_israel_form_v1',
      data: {
        ...data,
        formStartedDate: formStartedDateRef.current,
      },
      fileMeta,
      s3Documents,
    }
  }

  const onSubmit = async (data) => {
    const fid = buildFormId(data.passportId, formStartedDateRef.current)
    setAsyncFlow({ phase: 'working', message: '' })
    try {
      const uploads = await uploadFormDocumentsToS3(fid || 'unscoped', [
        { name: 'passportScan', file: firstFile(data.passportScan) },
        { name: 'existingVisaScan', file: firstFile(data.existingVisaScan) },
        { name: 'socialSecurityScan', file: firstFile(data.socialSecurityScan) },
        { name: 'americanLicenseScan', file: firstFile(data.americanLicenseScan) },
      ])
      const body = buildN8nBody('submit', fid, data, uploads)
      saveFormDraftToBrowser(fid || 'incomplete', { lastEvent: 'submit', ...body })
      // Blob backup is independent of n8n: runs first; failures are non-blocking for n8n.
      try {
        await saveFormBlobPayload(body)
      } catch (e) {
        console.warn('[blob]', e)
      }
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
    const values = getValues()
    if (!String(values.firstName || '').trim() || !String(values.lastName || '').trim()) {
      setAsyncFlow({
        phase: 'error',
        message: 'יש למלא שם פרטי ושם משפחה בעברית כדי לשמור טיוטה.',
      })
      return
    }
    setAsyncFlow({ phase: 'working', message: '' })
    try {
      const fid = buildFormId(values.passportId, formStartedDateRef.current)
      const uploads = await uploadFormDocumentsToS3(fid || 'unscoped', [
        { name: 'passportScan', file: firstFile(values.passportScan) },
        { name: 'existingVisaScan', file: firstFile(values.existingVisaScan) },
        { name: 'socialSecurityScan', file: firstFile(values.socialSecurityScan) },
        { name: 'americanLicenseScan', file: firstFile(values.americanLicenseScan) },
      ])
      const body = buildN8nBody('draft', fid, values, uploads)
      saveFormDraftToBrowser(fid || 'incomplete', { lastEvent: 'draft', ...body })
      await saveFormBlobPayload(body)
      setAsyncFlow({ phase: 'idle', message: 'Saved successfully' })
      console.log('[draft] S3 + Vercel Blob (+ local):', body)
    } catch (e) {
      setAsyncFlow({
        phase: 'error',
        message: e?.message || 'Save failed (S3 upload or Vercel Blob)',
      })
    }
  }

  const onLoadLocalDraft = async () => {
    const snap = loadFormDraftFromBrowser(storageFormId)
    if (!snap?.data || typeof snap.data !== 'object') {
      setAsyncFlow({ phase: 'error', message: 'אין טיוטה שמורה בדפדפן עבור מזהה זה' })
      return
    }
    const raw = snap.data && typeof snap.data === 'object' ? snap.data : {}
    const { passportDate: _omitPd, ...restData } = raw
    const companions =
      Array.isArray(restData.travelCompanions) && restData.travelCompanions.length > 0
        ? restData.travelCompanions
        : [{ fullName: '', relation: '' }]
    reset({
      ...restData,
      travelCompanions: companions,
      passportScan: undefined,
      existingVisaScan: undefined,
      socialSecurityScan: undefined,
      americanLicenseScan: undefined,
    })
    const { restored, failed } = await restoreS3DocumentsIntoForm(snap.s3Documents, setValue)
    const apiBase = getS3UploadApiBase()
    const hadMeta = Array.isArray(snap.s3Documents) && snap.s3Documents.length > 0
    let msg = 'טיוטה נטענה מהדפדפן.'
    if (restored > 0) {
      msg += ` שוחזרו ${restored} מסמכים מ-S3.`
      if (failed > 0) msg += ` ${failed} קבצים לא הורדו.`
    } else if (hadMeta && !apiBase) {
      msg +=
        ' במצב פיתוח ללא API להעלאה — מסמכים לא שוחזרו; הגדר VITE_S3_UPLOAD_API_URL או פתח בפרודקשן.'
    } else if (hadMeta && restored === 0) {
      msg += ' מסמכים שמורים בענן לא שוחזרו (בדוק הרשאות S3 או נסה לבחור מחדש).'
    }
    setAsyncFlow({ phase: 'idle', message: msg })
  }

  async function runPassportOcrFromFile(file) {
    setPassportOcr({ status: 'loading', message: '' })
    try {
      const r = await extractPassportFieldsFromFile(file)
      if (r.firstName) setValue('firstNameEnglish', r.firstName, { shouldDirty: true })
      if (r.lastName) setValue('lastNameEnglish', r.lastName, { shouldDirty: true })
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r.birthDate || '').trim())
      if (m) {
        setValue('birthDateYear', m[1], { shouldDirty: true })
        setValue('birthDateMonth', String(parseInt(m[2], 10)), { shouldDirty: true })
        setValue('birthDateDay', String(parseInt(m[3], 10)), { shouldDirty: true })
      }
      if (r.passportNumber) setValue('passportId', r.passportNumber, { shouldDirty: true })
      if (r.issuingCountry) setValue('passportIssuingCountry', r.issuingCountry, { shouldDirty: true })
      if (r.sex === 'M') setValue('sex', 'male', { shouldDirty: true })
      else if (r.sex === 'F') setValue('sex', 'female', { shouldDirty: true })
      if (r.nationalId) setValue('idNumber', r.nationalId, { shouldDirty: true })
      setPassportOcr({ status: 'idle', message: 'שדות דרכון עודכנו מהצילום.' })
    } catch (e) {
      setPassportOcr({ status: 'error', message: e?.message || 'שגיאה בזיהוי דרכון' })
    }
  }

  const wI94FirstEn = watch('firstNameEnglish')
  const wI94LastEn = watch('lastNameEnglish')
  const wI94FirstHe = watch('firstName')
  const wI94LastHe = watch('lastName')
  const wI94Day = watch('birthDateDay')
  const wI94Month = watch('birthDateMonth')
  const wI94Year = watch('birthDateYear')
  const wI94Passport = watch('passportId')
  const wI94Country = watch('passportIssuingCountry')
  const wPreviousUSVisits = watch('previousUSVisits')

  const i94SkipBecausePriorVisits = useMemo(
    () => Boolean(String(wPreviousUSVisits ?? '').trim()),
    [wPreviousUSVisits],
  )

  const canRunI94 = useMemo(() => {
    const pad = (n) => String(n ?? '').trim().padStart(2, '0')
    const y = String(wI94Year ?? '').trim()
    const okDate = /^\d{4}$/.test(y) && pad(wI94Month) !== '00' && pad(wI94Day) !== '00'
    const first = String(wI94FirstEn ?? '').trim() || String(wI94FirstHe ?? '').trim()
    const last = String(wI94LastEn ?? '').trim() || String(wI94LastHe ?? '').trim()
    return Boolean(first && last && okDate && String(wI94Passport ?? '').trim() && String(wI94Country ?? '').trim())
  }, [wI94FirstEn, wI94LastEn, wI94FirstHe, wI94LastHe, wI94Day, wI94Month, wI94Year, wI94Passport, wI94Country])

  async function handleI94Lookup() {
    if (String(getValues('previousUSVisits') ?? '').trim()) {
      return
    }
    setI94State({ status: 'loading', error: '', data: null })
    try {
      const y = String(wI94Year ?? '').trim()
      const m = String(wI94Month ?? '').trim().padStart(2, '0')
      const d = String(wI94Day ?? '').trim().padStart(2, '0')
      const birthDate = `${y}-${m}-${d}`
      const first = String(wI94FirstEn ?? '').trim() || String(wI94FirstHe ?? '').trim()
      const last = String(wI94LastEn ?? '').trim() || String(wI94LastHe ?? '').trim()
      const data = await fetchI94TravelHistory({
        firstName: first,
        lastName: last,
        birthDate,
        passportNumber: String(wI94Passport ?? '').trim(),
        country: String(wI94Country ?? '').trim(),
      })
      setI94State({ status: 'idle', error: '', data })

      if (data.success && Array.isArray(data.history) && data.history.length > 0) {
        const lines = data.history
          .map((row) => [row.date, row.type, row.location].map((s) => String(s ?? '').trim()).filter(Boolean).join(' — '))
          .filter(Boolean)
          .join('\n')
        if (lines) {
          setValue('visitedUSBefore', 'yes', { shouldDirty: true })
          setValue('previousUSVisits', lines, { shouldDirty: true })
        }
      }
    } catch (e) {
      setI94State({ status: 'error', error: e?.message || 'שגיאה', data: null })
    }
  }

  async function handleTranslateToEnglish() {
    setTranslateUi((s) => ({ ...s, loading: true, error: '' }))
    try {
      const values = getValues()
      const fp = buildTranslationFingerprint(values)
      let cached = null
      try {
        cached = await loadTranslationCache(storageFormId)
      } catch (e) {
        console.warn('[translation cache] load failed', e)
      }
      if (cached && cached.fingerprint === fp) {
        setTranslateUi({
          open: true,
          text: cached.translated,
          attachmentLabels: cached.attachmentLabels,
          pdfBase64: cached.pdfBase64,
          loading: false,
          error: '',
        })
        return
      }
      const { translated, attachmentLabels, pdfBase64 } = await translateFormToEnglish(values)
      try {
        await saveTranslationCache(storageFormId, {
          fingerprint: fp,
          translated,
          attachmentLabels,
          pdfBase64,
        })
      } catch (e) {
        console.warn('[translation cache] save failed', e)
      }
      setTranslateUi({
        open: true,
        text: translated,
        attachmentLabels,
        pdfBase64,
        loading: false,
        error: '',
      })
    } catch (e) {
      setTranslateUi((s) => ({ ...s, loading: false, error: e?.message || 'שגיאת תרגום' }))
    }
  }

  async function handleSendToMonday() {
    if (!translateUi.pdfBase64?.trim()) {
      setMondayUi((s) => ({ ...s, error: 'אין PDF זמין — הרץ תרגום מחדש.' }))
      return
    }
    setMondayUi({ loading: true, error: '', success: false, itemId: '' })
    try {
      const values = getValues()
      const en = `${values.firstNameEnglish || ''} ${values.lastNameEnglish || ''}`.trim()
      const he = `${values.firstName || ''} ${values.lastName || ''}`.trim()
      const applicantName = en || he || 'Applicant'
      const result = await sendPdfToMonday({
        applicantName,
        pdfBase64: translateUi.pdfBase64,
        status: 'DS-160 English summary',
        metadata: {
          formId: storageFormId,
          clientTimestamp: new Date().toISOString(),
        },
      })
      setMondayUi({
        loading: false,
        error: '',
        success: true,
        itemId: result.itemId,
      })
    } catch (e) {
      setMondayUi({
        loading: false,
        error: e?.message || 'שליחה ל-Monday נכשלה',
        success: false,
        itemId: '',
      })
    }
  }

  const w = {
    firstName: watch('firstName'),
    lastName: watch('lastName'),
    hadPreviousName: watch('hadPreviousName'),
    travelingWithOthers: watch('travelingWithOthers'),
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

  function getFieldError(path) {
    if (!path || !errors) return undefined
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), errors)
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gray-100 py-10 px-4 font-sans text-right">
      <div className="max-w-4xl mx-auto bg-white shadow-xl rounded-xl overflow-hidden">

        <div className="bg-blue-600 text-white p-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl font-bold">DS160 מותאם לישראל</h1>
            <p className="mt-2 text-blue-100">
              טופס מותאם לישראל. שדות מותנים יוצגו אוטומטית בהתאם לתשובות. מומלץ לשמור טיוטה לעיתים קרובות.
            </p>
            <p className="mt-3 text-sm font-mono bg-blue-700/50 rounded-md px-3 py-2 inline-block" dir="ltr">
              מזהה טופס: {formId || 'לא מוגדר — טיוטה תישמר תחת מפתח כללי בדפדפן'}
              <span className="block text-xs text-blue-100 mt-1 font-sans" dir="rtl">
                תאריך בסיומת המזהה (אוטומטי): {formStartedDateRef.current}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0 items-center">
            <button
              type="button"
              onClick={onLoadLocalDraft}
              disabled={asyncFlow.phase === 'working'}
              className="px-4 py-2 text-sm font-semibold rounded-md bg-white/10 hover:bg-white/20 border border-white/30 disabled:opacity-40"
            >
              טען טיוטה מהדפדפן
            </button>
            <button
              type="button"
              onClick={() => void onSaveDraft()}
              disabled={
                asyncFlow.phase === 'working' ||
                !String(w.firstName || '').trim() ||
                !String(w.lastName || '').trim()
              }
              title={
                !String(w.firstName || '').trim() || !String(w.lastName || '').trim()
                  ? 'יש למלא שם פרטי ושם משפחה כדי לשמור'
                  : undefined
              }
              className="px-4 py-2 text-sm font-semibold rounded-md bg-white text-blue-700 hover:bg-blue-50 border border-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              שמור טיוטה
            </button>
            {onExitToHome && (
              <button
                type="button"
                onClick={onExitToHome}
                className="px-4 py-2 text-sm font-semibold rounded-md bg-white/10 hover:bg-white/20 border border-white/30"
              >
                חזרה לרשימה
              </button>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-8 space-y-10">

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">שם הלקוח ומידע אישי</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col mb-4 md:col-span-2">
                <label className="font-semibold mb-1 text-gray-700">מספר דרכון</label>
                <input
                  type="text"
                  autoComplete="off"
                  {...register('passportId')}
                  className="border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 font-mono max-w-md"
                  dir="ltr"
                  placeholder="למשל 201381722"
                />
                <span className="text-xs text-gray-500 mt-1">
                  מזהה טיוטה בפורמט{' '}
                  <span className="font-mono" dir="ltr">
                    מספר_YYYY-MM-DD
                  </span>
                  : התאריך הוא <strong>אוטומטית</strong> תאריך תחילת מילוי הטופס ({formStartedDateRef.current}), לדפדפן ול-S3.
                </span>
              </div>
              <div className="md:col-span-2 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-4">
                <p className="font-semibold text-gray-800">צילום דרכון</p>
                <p className="text-xs text-gray-600">
                  גרירה או בחירת קובץ — זיהוי אוטומטי (GPT-4o): שם באנגלית, תאריך לידה, מספר דרכון, מדינת הנפקה, מין (MRZ), תעודת זהות אם מופיעה במסמך.
                </p>
                {passportOcr.status === 'loading' && (
                  <p className="text-sm text-blue-600">מזהה פרטי דרכון מהקובץ…</p>
                )}
                {passportOcr.status === 'error' && (
                  <p className="text-sm text-red-600" role="alert">
                    {passportOcr.message}
                  </p>
                )}
                {passportOcr.status === 'idle' && passportOcr.message && (
                  <p className="text-sm text-green-700">{passportOcr.message}</p>
                )}
                <DocumentFileSlot
                  label="העלאת צילום דרכון"
                  name="passportScan"
                  register={register}
                  setValue={setValue}
                  getFieldError={getFieldError}
                  watchedValue={passportScanWatch}
                  accept="image/*,application/pdf"
                  onFilePicked={(f) => {
                    void runPassportOcrFromFile(f)
                  }}
                />
              </div>
              <FormInput register={register} getFieldError={getFieldError} label="שם פרטי" name="firstName" />
              <FormInput register={register} getFieldError={getFieldError} label="שם משפחה" name="lastName" />
              <FormInput register={register} getFieldError={getFieldError}
                label="שם פרטי באנגלית (מדרכון)"
                name="firstNameEnglish"
                hint="ממולא אוטומטית מצילום הדרכון; לא מחליף את השם בעברית"
              />
              <FormInput register={register} getFieldError={getFieldError}
                label="שם משפחה באנגלית (מדרכון)"
                name="lastNameEnglish"
                hint="ממולא אוטומטית מצילום הדרכון; לא מחליף את השם בעברית"
              />

              <FormRadioGroup register={register} getFieldError={getFieldError} label="במידה והיה שם קודם" name="hadPreviousName" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.hadPreviousName === 'yes' && (
                <FormInput register={register} getFieldError={getFieldError} label="שם קודם (הקלד)" name="previousNameValue" />
              )}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="מין" name="sex" options={[{ label: 'זכר', value: 'male' }, { label: 'נקבה', value: 'female' }]} />
              <FormSelect register={register} getFieldError={getFieldError} label="סטטוס" name="maritalStatus" options={['רווק', 'נשוי', 'גרוש', 'אלמן', 'נשוי אזרחית', 'פרוד', 'חיים משותפים']} />

              <div className="flex flex-col mb-4">
                <label className="font-semibold mb-1 text-gray-700">תאריך לידה</label>
                <div className="flex gap-2">
                  <input type="text" {...register('birthDateDay')} placeholder="יום" className="border border-gray-300 rounded-md p-2 w-full" />
                  <input type="text" {...register('birthDateMonth')} placeholder="חודש" className="border border-gray-300 rounded-md p-2 w-full" />
                  <input type="text" {...register('birthDateYear')} placeholder="שנה" className="border border-gray-300 rounded-md p-2 w-full" />
                </div>
              </div>

              <FormRadioGroup register={register} getFieldError={getFieldError} label="מתחת ל 14?" name="isUnder14" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              <FormInput register={register} getFieldError={getFieldError} label="עיר לידה (אם בחו״ל, לציין מדינה)" name="birthCity" />
              <FormInput register={register} getFieldError={getFieldError} label="מספר תעודת הזהות" name="idNumber" />
              <FormInput register={register} getFieldError={getFieldError}
                label="מדינת הנפקת דרכון (באנגלית)"
                name="passportIssuingCountry"
                hint="ניתן למלא ידנית או לעדכן אוטומטית מזיהוי צילום הדרכון"
              />
              <FormInput register={register} getFieldError={getFieldError} label="כתובת מגורים נוכחית - רחוב" name="addressStreet" />
              <FormInput register={register} getFieldError={getFieldError} label="(מספר דירה / apt number)" name="addressApt" />
              <FormInput register={register} getFieldError={getFieldError} label="עיר" name="addressCity" />
              <FormInput register={register} getFieldError={getFieldError} label="טלפון" name="phone" hint="אין מקום לכתוב מקף. Format: 0000000000" />
              <FormInput register={register} getFieldError={getFieldError} label="Email" name="email" type="email" />

              <FormRadioGroup register={register} getFieldError={getFieldError} label="אזרחות זרה?" name="hasForeignCitizenship" options={[{ label: 'לא', value: 'no' }, { label: 'של איזה מדינה?', value: 'yes' }]} />
              {w.hasForeignCitizenship === 'yes' && (
                <FormInput register={register} getFieldError={getFieldError} label="של איזה מדינה (אזרחות זרה)" name="foreignCitizenshipCountry" />
              )}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">תכנון נסיעה לארה&quot;ב</h2>
            <div className="grid grid-cols-1 gap-4">
              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אתה מתכנן לטוס עם אנשים נוספים?" name="travelingWithOthers" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.travelingWithOthers === 'yes' && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
                  <p className="font-semibold text-gray-800">נוסעים נוספים</p>
                  {travelCompanionFields.map((field, index) => (
                    <div
                      key={field.id}
                      className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-4 items-end border-b border-gray-200 pb-4 last:border-b-0 last:pb-0"
                    >
                      <FormInput register={register} getFieldError={getFieldError} label="שם מלא" name={`travelCompanions.${index}.fullName`} />
                      <FormInput register={register} getFieldError={getFieldError} label="קרבה אליך" name={`travelCompanions.${index}.relation`} />
                      <div className="flex justify-end md:justify-start pb-1">
                        {index > 0 && (
                          <button
                            type="button"
                            onClick={() => removeTravelCompanion(index)}
                            className="text-sm text-red-600 hover:text-red-800 underline"
                          >
                            הסר
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => appendTravelCompanion({ fullName: '', relation: '' })}
                    className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                  >
                    <span aria-hidden className="text-lg leading-none">+</span>
                    הוסף נוסע
                  </button>
                </div>
              )}
              <FormInput register={register} getFieldError={getFieldError} label="מתי התכנון לטוס לארה״ב?" name="plannedDepartureDate" />
              <FormInput register={register} getFieldError={getFieldError} label="לכמה זמן?" name="plannedStayDuration" />
              <FormInput register={register} getFieldError={getFieldError} label="איפה תלון בארה״ב?" name="accommodationInUS" type="textarea" />
              <FormInput register={register} getFieldError={getFieldError} label="מי משלם בעבור מגיש הבקשה על הנסיעה?" name="tripFundingSource" />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">ויזה קודמת לארה&quot;ב</h2>
            <div className="grid grid-cols-1 gap-4">
              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אי פעם ביקרת בארה״ב?" name="visitedUSBefore" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.visitedUSBefore === 'yes' && (
                <FormInput register={register} getFieldError={getFieldError}
                  label="בערך מתי ולכמה זמן [עד 5 אחרונות]"
                  name="previousUSVisits"
                  type="textarea"
                  hint="ניתן למלא ידנית או להריץ 'בדוק היסטוריית כניסות' (I-94) למטה — הרשומות יועתקו לכאן אוטומטית."
                />
              )}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="הייתה לך בעבר ויזה לארה״ב?" name="hadUSVisa" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.hadUSVisa === 'yes' && (
                <div className="pl-4 border-r-4 border-blue-500 space-y-4 pr-4 bg-gray-50 p-4 rounded">
                  <FormInput register={register} getFieldError={getFieldError} label="תאריך הנפקת הויזה האחרונה" name="lastVisaIssueDate" />
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם הויזה הקודמת שלך הונפקה בישראל?" name="visaIssuedInIsrael" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם הויזה שלך בוטלה?" name="visaWasCancelled" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                </div>
              )}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם סורבת בעבר לויזה לארה״ב" name="visaRefused" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.visaRefused === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="הסבר מדוע לדעתך, ובאיזה תאריך סורבת לויזה" name="visaRefusalExplanation" type="textarea" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="סורבת בעבר כניסה לארה״ב?" name="deniedEntryToUS" options={[{ label: 'לא', value: 'no' }, { label: 'מי איך ומתי', value: 'yes' }]} />
              {w.deniedEntryToUS === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="פרטי סירוב כניסה (מי, איך, מתי)" name="deniedEntryDetails" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם שהית באופן לא חוקי בארה״ב והפרת את תנאי הויזה?" name="illegalStayInUS" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.illegalStayInUS === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="פרט מדוע שהית באופן לא חוקי" name="illegalStayDetails" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם בעבר הגשת בקשה לגרין קארד?" name="appliedForGreenCard" options={[{ label: 'לא', value: 'no' }, { label: 'מי איך ומתי', value: 'yes' }]} />
              {w.appliedForGreenCard === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="פרטי בקשת גרין קארד (מי, איך, מתי)" name="greenCardDetails" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="U.S. Social Security Number (במידה וביקר בעבר)" name="hasSocialSecurityNumber" options={[{ label: 'לא', value: 'no' }, { label: 'מספר סושיאל', value: 'yes' }]} />
              {w.hasSocialSecurityNumber === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="מספר סושיאל סקוריטי" name="socialSecurityNumber" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="U.S. Taxpayer ID Number (במידה וביקר בעבר)" name="hasTaxpayerID" options={[{ label: 'לא', value: 'no' }, { label: 'מה הוא המספר משלם מיסים?', value: 'yes' }]} />
              {w.hasTaxpayerID === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="מספר משלם מיסים אמריקאי" name="taxpayerIDNumber" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="היה לך רישיון נהיגה אמריקאי?" name="hasUSDriversLicense" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.hasUSDriversLicense === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="של איזה מדינה ומה המספר רישיון?" name="driversLicenseDetails" type="textarea" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אי פעם אבד או נגנב לך הדרכון?" name="passportLostOrStolen" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.passportLostOrStolen === 'yes' && (
                <div className="pl-4 border-r-4 border-blue-500 space-y-4 pr-4 bg-gray-50 p-4 rounded">
                  <FormInput register={register} getFieldError={getFieldError} label="מתי בערך אבד הדרכון?" name="lostPassportWhen" />
                  <FormInput register={register} getFieldError={getFieldError} label="של איזה מדינה הדרכון שאבד?" name="lostPassportCountry" />
                  <FormInput register={register} getFieldError={getFieldError} label="מספר הדרכון שאבד במידה וידוע" name="lostPassportNumber" />
                  <FormInput register={register} getFieldError={getFieldError} label="פרט על אירוע הגניבה / אבדה של הדרכון" name="lostPassportDescription" type="textarea" />
                </div>
              )}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">איש קשר בארה&quot;ב</h2>
            <FormRadioGroup register={register} getFieldError={getFieldError} label="יש לך איש קשר בארה״ב?" name="hasUSContact" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.hasUSContact === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <FormSelect register={register} getFieldError={getFieldError} label="קרבת איש הקשר עבורך" name="contactRelationship" options={['קרוב משפחה', 'חבר', 'מעסיק אמריקאי', 'שותף / לקוח עסקי', 'בעל או אישה', 'מוסד לימודים אמריקאי', 'אחר']} />
                <FormInput register={register} getFieldError={getFieldError} label="שם מלא של איש הקשר" name="contactFullName" />
                <FormInput register={register} getFieldError={getFieldError} label="טלפון של איש הקשר" name="contactPhone" />
                <div className="col-span-1 md:col-span-2">
                  <FormInput register={register} getFieldError={getFieldError} label="כתובת מלאה של איש הקשר" name="contactAddress" type="textarea" />
                </div>
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">הורים בני זוג ומשפחה</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormInput register={register} getFieldError={getFieldError} label="שם האבא" name="fatherFullName" />
              <FormInput register={register} getFieldError={getFieldError} label="תאריך לידה של האבא" name="fatherBirthDate" placeholder="No Date Of Birth for Parent" />
              <FormInput register={register} getFieldError={getFieldError} label="שם האמא" name="motherFullName" />
              <FormInput register={register} getFieldError={getFieldError} label="תאריך לידה של האמא" name="motherBirthDate" placeholder="No Date Of Birth for Parent" />
            </div>

            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך משפחה מקרבה ראשונה בארה״ב?" name="hasCloseRelativesInUS" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }, { label: 'יש רחוקה', value: 'distant' }]} />

            {w.hasCloseRelativesInUS === 'yes' && (
              <div className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
                <FormInput register={register} getFieldError={getFieldError} label="שם מלא (קרוב משפחה בארה״ב)" name="relativeFullName" />
                <FormSelect register={register} getFieldError={getFieldError} label="קרבה אלייך" name="relativeRelationship" options={['הורה', 'אח/ות', 'ילד/ה', 'בעל/אישה']} />
                <FormSelect register={register} getFieldError={getFieldError} label="סטטוס בארה״ב" name="relativeUSStatus" options={['גרין קארד (LPR)', 'אזרח', 'אשרת סטודנט', 'אשרת עבודה', 'מטייל', 'אחר']} />
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">עיסוק נוכחי</h2>
            <FormSelect register={register} getFieldError={getFieldError} label="עיסוק נוכחי" name="currentOccupation" options={['עובד', 'סטודנט', 'חייל', 'פנסיה', 'מובטל', 'עקר/ת בית']} />

            {w.currentOccupation === 'עובד' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">פרטי עבודה נוכחית</h3>
                <FormInput register={register} getFieldError={getFieldError} label="שם החברה בה עובד" name="employerName" />
                <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב החברה" name="employerStreet" />
                <FormInput register={register} getFieldError={getFieldError} label="עיר" name="employerCity" />
                <FormInput register={register} getFieldError={getFieldError} label="תפקיד" name="jobTitle" />
                <FormInput register={register} getFieldError={getFieldError} label="טלפון בחברה" name="employerPhone" />
                <FormInput register={register} getFieldError={getFieldError} label="תאריך התחלה" name="employmentStartDate" />
                <FormInput register={register} getFieldError={getFieldError} label="שכר חודשי ברוטו" name="monthlySalaryGross" />
              </div>
            )}

            {w.currentOccupation === 'חייל' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">פרטי שירות צבאי</h3>
                <FormInput register={register} getFieldError={getFieldError} label="בצבא של איזה מדינה?" name="militaryCountry" />
                <FormInput register={register} getFieldError={getFieldError} label="באיזה חייל?" name="militaryBranch" />
                <FormInput register={register} getFieldError={getFieldError} label="תפקיד בצבא" name="militaryRole" />
                <FormInput register={register} getFieldError={getFieldError} label="כתובת הבסיס" name="militaryBaseAddress" />
                <FormInput register={register} getFieldError={getFieldError} label="טלפון ביחידה/מפקד" name="militaryUnitPhone" />
                <FormInput register={register} getFieldError={getFieldError} label="שכר" name="militarySalary" />
                <FormInput register={register} getFieldError={getFieldError} label="דרגה" name="militaryRank" />
                <FormInput register={register} getFieldError={getFieldError} label="תאריך גיוס" name="militaryDraftDate" />
                <FormInput register={register} getFieldError={getFieldError} label="תאריך שחרור" name="militaryDischargeDate" />
              </div>
            )}

            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם עבדת במקום נוסף במסגרת 5 שנים אחרונות?" name="workedAnotherJobLast5Years" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />

            {w.workedAnotherJobLast5Years === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200 mt-4">
                <h3 className="col-span-full font-bold text-lg">עבודה קודמת במסגרת 5 שנים אחרונות</h3>
                <FormInput register={register} getFieldError={getFieldError} label="שם החברה הקודמת" name="prevEmployerName" />
                <FormInput register={register} getFieldError={getFieldError} label="כתובת הרחוב החברה" name="prevEmployerStreet" />
                <FormInput register={register} getFieldError={getFieldError} label="עיר" name="prevEmployerCity" />
                <FormInput register={register} getFieldError={getFieldError} label="תפקיד" name="prevJobTitle" />
                <FormInput register={register} getFieldError={getFieldError} label="שם המנהל" name="prevManagerName" />
                <FormInput register={register} getFieldError={getFieldError} label="טלפון בחברה" name="prevEmployerPhone" />
                <FormInput register={register} getFieldError={getFieldError} label="תאריך התחלה" name="prevEmploymentStartDate" />
                <FormInput register={register} getFieldError={getFieldError} label="תאריך סיום העסקה" name="prevEmploymentEndDate" />
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">לימודים</h2>

            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם למדת בתיכון?" name="attendedHighSchool" options={[{ label: 'לא למדתי בתיכון', value: 'no' }, { label: 'פרט, שם התיכון וכתובת', value: 'yes' }]} />
            {w.attendedHighSchool === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="שם התיכון וכתובת" name="highSchoolDetails" type="textarea" />}

            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש תואר אקדמאי?" name="hasAcademicDegree" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.hasAcademicDegree === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">מוסד לימודים 1</h3>
                <FormInput register={register} getFieldError={getFieldError} label="שם מוסד הלימודים" name="institutionName" />
                <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב" name="institutionStreet" />
                <FormInput register={register} getFieldError={getFieldError} label="עיר" name="institutionCity" />
                <FormInput register={register} getFieldError={getFieldError} label="מה למדת?" name="fieldOfStudy" />
                <FormInput register={register} getFieldError={getFieldError} label="שנת וחודש התחלה" name="studyStartYearMonth" />
                <FormInput register={register} getFieldError={getFieldError} label="שנת וחודש סיום" name="studyEndYearMonth" />

                <div className="col-span-full">
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם למדת תואר אקדמי נוסף?" name="hasAdditionalAcademicDegree" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                </div>
              </div>
            )}

            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם ביקרת בחו״ל ב-5 שנים האחרונות?" name="visitedAbroadLast5Years" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.visitedAbroadLast5Years === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="מדינות ב-5 שנים האחרונות" name="countriesVisitedLast5Years" type="textarea" />}

            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם שירתת בצבא?" name="servedInMilitary" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.servedInMilitary === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200 mt-4">
                <h3 className="col-span-full font-bold text-lg">שירות צבאי (היסטוריה)</h3>
                <FormInput register={register} getFieldError={getFieldError} label="לציין אם לא בישראל" name="milHistoryCountry" />
                <FormInput register={register} getFieldError={getFieldError} label="איזה חייל?" name="milHistoryBranch" />
                <FormInput register={register} getFieldError={getFieldError} label="תפקיד" name="milHistoryRole" />
                <FormInput register={register} getFieldError={getFieldError} label="דרגת שחרור" name="milHistoryDischargeRank" />
                <FormInput register={register} getFieldError={getFieldError} label="תאריך גיוס" name="milHistoryDraftDate" />
                <FormInput register={register} getFieldError={getFieldError} label="תאריך שחרור" name="milHistoryDischargeDate" />
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
              <FormRadioGroup register={register} getFieldError={getFieldError}
                label="Have you ever been arrested and / or do you have a criminal record / a police case?"
                name="criminalRecord"
                options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]}
                note="סופר חשוב: יש לוודא שהלקוח מבין את חשיבות השאלה הזו."
              />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">רשתות חברתיות</h2>
            <FormInput register={register} getFieldError={getFieldError} label="קישורים לרשתות החברתיות" name="socialMediaLinks" type="textarea" />
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">מיקום ראיון</h2>
            <FormRadioGroup register={register} getFieldError={getFieldError} label="לאן תגש לראיון?" name="interviewLocation" options={[
              { label: 'הירקון 71, תל אביב', value: 'tel_aviv' },
              { label: 'דוד פלוסר 14, ירושלים', value: 'jerusalem' },
            ]} />
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">מסמכים נוספים</h2>
            <p className="text-sm text-gray-600">
              מסמכים מוצגים לפי מה שסימנת בטופס (ויזה קודמת, סושיאל, רישיון נהיגה אמריקאי). צילום הדרכון נמצא למעלה ליד מספר הדרכון.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(w.visitedUSBefore === 'yes' || w.hadUSVisa === 'yes') && (
                <DocumentFileSlot
                  label="ויזה קודמת במידה ויש"
                  name="existingVisaScan"
                  register={register}
                  setValue={setValue}
                  getFieldError={getFieldError}
                  watchedValue={existingVisaScanWatch}
                  accept="image/*,application/pdf"
                />
              )}
              {w.hasSocialSecurityNumber === 'yes' && (
                <DocumentFileSlot
                  label="צילום Social Security Card (ארה״ב)"
                  name="socialSecurityScan"
                  register={register}
                  setValue={setValue}
                  getFieldError={getFieldError}
                  watchedValue={socialSecurityScanWatch}
                  accept="image/*,application/pdf"
                />
              )}
              {w.hasUSDriversLicense === 'yes' && (
                <DocumentFileSlot
                  label="רישיון נהיגה אמריקאי (צילום)"
                  name="americanLicenseScan"
                  register={register}
                  setValue={setValue}
                  getFieldError={getFieldError}
                  watchedValue={americanLicenseScanWatch}
                  accept="image/*,application/pdf"
                />
              )}
            </div>
            {!(
              (w.visitedUSBefore === 'yes' || w.hadUSVisa === 'yes') ||
              w.hasSocialSecurityNumber === 'yes' ||
              w.hasUSDriversLicense === 'yes'
            ) && (
              <p className="text-sm text-gray-500">
                אין כאן מסמכים נוספים להעלאה — סמן ביקור/ויזה קודמת בארה״ב, סושיאל, או רישיון נהיגה אמריקאי בטופס כדי להציג את השדות הרלוונטיים.
              </p>
            )}

            {canRunI94 && (
              <div className="rounded-lg border border-gray-200 bg-slate-50 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold text-gray-800">היסטוריית כניסות (I-94)</h3>
                  <button
                    type="button"
                    disabled={
                      i94State.status === 'loading' ||
                      asyncFlow.phase === 'working' ||
                      i94SkipBecausePriorVisits
                    }
                    onClick={() => void handleI94Lookup()}
                    className="px-4 py-2 text-sm font-semibold rounded-md bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40"
                  >
                    {i94State.status === 'loading' ? 'טוען…' : 'בדוק היסטוריית כניסות'}
                  </button>
                </div>
                {i94SkipBecausePriorVisits && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    שדה &quot;ביקורים קודמים בארה״ב&quot; כבר מלא — לא תורץ בדיקת I-94 (חיסכון בעלות). רוקנו את השדה כדי להפעיל.
                  </p>
                )}
                <p className="text-xs text-gray-600">
                  נדרשים שם (באנגלית מהדרכון או בעברית), תאריך לידה מלא, מספר דרכון ומדינת הנפקה באנגלית. I-94 משתמש בשם האנגלי אם מולא. הפעולה רצה בענן (Browser Use).
                </p>
                {i94State.error && (
                  <p className="text-sm text-red-600" role="alert">
                    {i94State.error}
                  </p>
                )}
                {i94State.data && (
                  <div className="overflow-x-auto">
                    {!i94State.data.success && (
                      <p className="text-sm text-amber-800">לא הוחזרה היסטוריה (success=false).</p>
                    )}
                    {i94State.data.history?.length > 0 ? (
                      <table className="min-w-full text-sm border border-gray-200 bg-white rounded-md">
                        <thead>
                          <tr className="bg-gray-100 text-right">
                            <th className="p-2 border-b">תאריך</th>
                            <th className="p-2 border-b">סוג</th>
                            <th className="p-2 border-b">מיקום</th>
                          </tr>
                        </thead>
                        <tbody>
                          {i94State.data.history.map((row, i) => (
                            <tr key={`${row.date}-${i}`} className="border-b border-gray-100">
                              <td className="p-2 font-mono" dir="ltr">
                                {row.date}
                              </td>
                              <td className="p-2">{row.type}</td>
                              <td className="p-2">{row.location}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      i94State.data.success && <p className="text-sm text-gray-600">אין רשומות היסטוריה.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <div className="pt-6 border-t flex flex-col items-end gap-2">
            {asyncFlow.phase === 'working' && (
              <p className="text-sm text-blue-600">שומר במכשיר, מעלה ל-S3 אם הוגדר, שומר בענן…</p>
            )}
            {asyncFlow.phase === 'idle' && asyncFlow.message && (
              <p className="text-sm text-green-700 max-w-xl text-right">{asyncFlow.message}</p>
            )}
            {asyncFlow.phase === 'error' && (
              <p className="text-sm text-red-600 max-w-xl text-right">{asyncFlow.message}</p>
            )}
            {translateUi.error && (
              <p className="text-sm text-red-600 w-full text-right" role="alert">
                {translateUi.error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-4">
              {onExitToHome && (
                <button
                  type="button"
                  onClick={onExitToHome}
                  className="px-6 py-2 border border-gray-400 text-gray-700 font-semibold rounded-md hover:bg-gray-50 transition"
                >
                  חזרה לרשימה
                </button>
              )}
              <button
                type="button"
                disabled={asyncFlow.phase === 'working' || translateUi.loading}
                onClick={() => void handleTranslateToEnglish()}
                className="px-6 py-2 border border-slate-700 text-slate-800 font-semibold rounded-md hover:bg-slate-50 transition disabled:opacity-40"
              >
                {translateUi.loading ? 'מתרגם…' : 'תרגם לאנגלית (ChatGPT)'}
              </button>
              <button
                type="button"
                disabled={
                  asyncFlow.phase === 'working' ||
                  !String(w.firstName || '').trim() ||
                  !String(w.lastName || '').trim()
                }
                onClick={() => void onSaveDraft()}
                className="px-6 py-2 border border-blue-600 text-blue-600 font-semibold rounded-md hover:bg-blue-50 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                שמור טיוטה
              </button>
              <button
                type="submit"
                disabled={asyncFlow.phase === 'working'}
                className="hidden px-6 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 transition shadow-md disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
                aria-hidden="true"
                tabIndex={-1}
              >
                שלח טופס
              </button>
            </div>
          </div>
        </form>
      </div>

      {translateUi.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="translate-title"
        >
          <div className="max-w-3xl w-full max-h-[85vh] bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden" dir="ltr">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h2 id="translate-title" className="text-lg font-bold text-gray-900">
                English translation
              </h2>
              <div className="flex gap-2">
                {translateUi.pdfBase64 ? (
                  <>
                    <button
                      type="button"
                      className="text-sm px-3 py-1.5 rounded-md border border-blue-600 text-blue-700 hover:bg-blue-50"
                      onClick={() => {
                        try {
                          const bin = atob(translateUi.pdfBase64)
                          const bytes = new Uint8Array(bin.length)
                          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
                          const blob = new Blob([bytes], { type: 'application/pdf' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = 'ds160-english-summary.pdf'
                          a.click()
                          URL.revokeObjectURL(url)
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      Download PDF
                    </button>
                    <button
                      type="button"
                      disabled={mondayUi.loading}
                      className="text-sm px-3 py-1.5 rounded-md border border-violet-600 text-violet-700 hover:bg-violet-50 disabled:opacity-40"
                      onClick={() => void handleSendToMonday()}
                    >
                      {mondayUi.loading ? 'שולח…' : 'שלח ל-Monday'}
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="text-sm px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(translateUi.text)
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="text-sm px-3 py-1.5 rounded-md bg-gray-900 text-white hover:bg-gray-800"
                  onClick={() => {
                    setMondayUi({ loading: false, error: '', success: false, itemId: '' })
                    setTranslateUi((s) => ({ ...s, open: false }))
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            {(mondayUi.error || mondayUi.success) && (
              <div className="px-4 py-2 text-sm border-b text-left" dir="ltr">
                {mondayUi.error ? (
                  <p className="text-red-600" role="alert">
                    {mondayUi.error}
                  </p>
                ) : null}
                {mondayUi.success ? (
                  <p className="text-green-700">
                    נוצר פריט ב-Monday. מזהה: <span className="font-mono">{mondayUi.itemId}</span>
                  </p>
                ) : null}
              </div>
            )}
            {translateUi.attachmentLabels?.length > 0 && (
              <p className="px-4 pt-3 text-xs text-gray-600 border-b pb-2 text-left" dir="ltr">
                Analyzed documents: {translateUi.attachmentLabels.join(', ')}
              </p>
            )}
            <div className="p-4 overflow-y-auto text-sm whitespace-pre-wrap text-gray-800 font-sans text-left">
              {translateUi.text}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
