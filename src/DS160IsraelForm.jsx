import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm, useFieldArray } from 'react-hook-form'
import { saveFormDraftToBrowser, loadFormDraftFromBrowser } from './lib/formStorage.js'
import { postFormToN8n } from './lib/n8nWebhook.js'
import { serializeFormValuesForJson } from './lib/serializeFormPayload.js'
import { firstFile, uploadFormDocumentsToS3 } from './lib/uploadFormDocuments.js'
import { buildFormId } from './lib/formId.js'
import { saveFormBlobPayload } from './lib/formBlob.js'
import { calculateCompleteness } from './lib/formCompleteness.js'
import { extractPassportFieldsFromFile } from './lib/passportOcr.js'
import { extractSocialSecurityNumberFromFile } from './lib/socialSecurityOcr.js'
import { extractUsLicenseFieldsFromFile } from './lib/usLicenseOcr.js'
import { extractUsVisaDatesFromFile } from './lib/usVisaOcr.js'
import { fetchI94TravelHistory } from './lib/browserUse.js'
import { translateFormToEnglish } from './lib/translateForm.js'
import {
  buildTranslationFingerprint,
  saveTranslationCache,
} from './lib/translationCache.js'
import { restoreS3DocumentsIntoForm } from './lib/restoreFormDocumentsFromS3.js'
import { getS3UploadApiBase } from './lib/uploadFormDocuments.js'
import { sendPdfToMonday, searchMondayItem } from './lib/monday.js'

/**
 * Keeps latest S3 object per document field (passport / visa / SSN card / license) for translate + PDF when the browser has no File.
 * @param {unknown[]} prev
 * @param {unknown[]} next
 */
function mergeS3DocumentsByField(prev, next) {
  const map = new Map()
  for (const d of Array.isArray(prev) ? prev : []) {
    const f = d && typeof d.field === 'string' ? d.field : ''
    const k = d && typeof d.key === 'string' ? d.key : ''
    if (f && k) map.set(f, { field: f, key: k, ...(d.bucket ? { bucket: d.bucket } : {}) })
  }
  for (const d of Array.isArray(next) ? next : []) {
    const f = d && typeof d.field === 'string' ? d.field : ''
    const k = d && typeof d.key === 'string' ? d.key : ''
    if (f && k) map.set(f, { field: f, key: k, ...(d.bucket ? { bucket: d.bucket } : {}) })
  }
  return [...map.values()]
}

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
function FormInput({ label, name, type = 'text', note, hint, placeholder, dir, register, getFieldError }) {
  const fieldError = getFieldError(name)
  return (
    <div id={`field-${name}`} className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}</label>
      {note && <span className="text-sm text-gray-500 mb-1">{note}</span>}
      {type === 'textarea' ? (
        <textarea
          {...register(name)}
          className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 border ${fieldError ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
          placeholder={placeholder}
          rows={3}
          dir={dir}
        />
      ) : (
        <input
          type={type}
          {...register(name)}
          className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 border ${fieldError ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
          placeholder={placeholder}
          dir={dir}
        />
      )}
      {hint && <span className="text-xs text-gray-400 mt-1">{hint}</span>}
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שגיאה בשדה'}</span>}
    </div>
  )
}


function FormRadioGroup({ label, name, options, note, register, getFieldError }) {
  const fieldError = getFieldError(name)
  return (
    <div id={`field-${name}`} className={`flex flex-col mb-4 ${fieldError ? 'rounded-md bg-red-50 p-2 -mx-2' : ''}`}>
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
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שדה חובה'}</span>}
    </div>
  )
}

function FormSelect({ label, name, options, register, getFieldError }) {
  const fieldError = getFieldError(name)
  return (
    <div id={`field-${name}`} className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}</label>
      <select
        {...register(name)}
        className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 border ${fieldError ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
      >
        <option value="">בחר...</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שדה חובה'}</span>}
    </div>
  )
}

/** Sticky panel listing unfilled required fields. Clicking an item scrolls to the field. */
function MissingFieldsPanel({ values }) {
  const [open, setOpen] = useState(false)
  const result = useMemo(() => calculateCompleteness(values), [values])
  const { isComplete, missingFields } = result

  if (isComplete || missingFields.length === 0) return null

  function scrollToField(field) {
    const el = document.getElementById(`field-${field}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setOpen(false)
  }

  return (
    <div className="fixed bottom-6 left-4 z-50 max-w-xs w-full" dir="rtl">
      <div className="bg-white rounded-xl shadow-2xl border border-orange-200 overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-orange-50 hover:bg-orange-100 transition-colors text-right"
        >
          <span className="font-semibold text-orange-800 text-sm">
            ⚠️ {missingFields.length} שדות חסרים
          </span>
          <span className="text-orange-500 text-xs">{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <ul className="max-h-64 overflow-y-auto divide-y divide-gray-100">
            {missingFields.map((f) => (
              <li key={f.field}>
                <button
                  type="button"
                  onClick={() => scrollToField(f.field)}
                  className="w-full text-right px-4 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-800 transition-colors"
                >
                  {f.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Full-screen loading overlay with spinner and optional message. */
function LoadingOverlay({ message }) {
  if (!message) return null
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/50 backdrop-blur-sm" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl px-10 py-8 flex flex-col items-center gap-4 max-w-xs w-full mx-4">
        <svg className="animate-spin h-10 w-10 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        <p className="text-gray-800 font-semibold text-center text-sm leading-relaxed">{message}</p>
      </div>
    </div>
  )
}

const COUNTRY_CODES = [
  { code: '972', flag: '🇮🇱', name: 'Israel' },
  { code: '1', flag: '🇺🇸', name: 'USA / Canada' },
  { code: '44', flag: '🇬🇧', name: 'UK' },
  { code: '49', flag: '🇩🇪', name: 'Germany' },
  { code: '33', flag: '🇫🇷', name: 'France' },
  { code: '39', flag: '🇮🇹', name: 'Italy' },
  { code: '34', flag: '🇪🇸', name: 'Spain' },
  { code: '31', flag: '🇳🇱', name: 'Netherlands' },
  { code: '32', flag: '🇧🇪', name: 'Belgium' },
  { code: '41', flag: '🇨🇭', name: 'Switzerland' },
  { code: '43', flag: '🇦🇹', name: 'Austria' },
  { code: '46', flag: '🇸🇪', name: 'Sweden' },
  { code: '47', flag: '🇳🇴', name: 'Norway' },
  { code: '45', flag: '🇩🇰', name: 'Denmark' },
  { code: '358', flag: '🇫🇮', name: 'Finland' },
  { code: '48', flag: '🇵🇱', name: 'Poland' },
  { code: '420', flag: '🇨🇿', name: 'Czech Republic' },
  { code: '36', flag: '🇭🇺', name: 'Hungary' },
  { code: '40', flag: '🇷🇴', name: 'Romania' },
  { code: '30', flag: '🇬🇷', name: 'Greece' },
  { code: '351', flag: '🇵🇹', name: 'Portugal' },
  { code: '7', flag: '🇷🇺', name: 'Russia' },
  { code: '380', flag: '🇺🇦', name: 'Ukraine' },
  { code: '375', flag: '🇧🇾', name: 'Belarus' },
  { code: '90', flag: '🇹🇷', name: 'Turkey' },
  { code: '20', flag: '🇪🇬', name: 'Egypt' },
  { code: '27', flag: '🇿🇦', name: 'South Africa' },
  { code: '234', flag: '🇳🇬', name: 'Nigeria' },
  { code: '254', flag: '🇰🇪', name: 'Kenya' },
  { code: '212', flag: '🇲🇦', name: 'Morocco' },
  { code: '216', flag: '🇹🇳', name: 'Tunisia' },
  { code: '213', flag: '🇩🇿', name: 'Algeria' },
  { code: '218', flag: '🇱🇾', name: 'Libya' },
  { code: '249', flag: '🇸🇩', name: 'Sudan' },
  { code: '251', flag: '🇪🇹', name: 'Ethiopia' },
  { code: '233', flag: '🇬🇭', name: 'Ghana' },
  { code: '255', flag: '🇹🇿', name: 'Tanzania' },
  { code: '256', flag: '🇺🇬', name: 'Uganda' },
  { code: '260', flag: '🇿🇲', name: 'Zambia' },
  { code: '263', flag: '🇿🇼', name: 'Zimbabwe' },
  { code: '91', flag: '🇮🇳', name: 'India' },
  { code: '86', flag: '🇨🇳', name: 'China' },
  { code: '81', flag: '🇯🇵', name: 'Japan' },
  { code: '82', flag: '🇰🇷', name: 'South Korea' },
  { code: '65', flag: '🇸🇬', name: 'Singapore' },
  { code: '60', flag: '🇲🇾', name: 'Malaysia' },
  { code: '62', flag: '🇮🇩', name: 'Indonesia' },
  { code: '63', flag: '🇵🇭', name: 'Philippines' },
  { code: '66', flag: '🇹🇭', name: 'Thailand' },
  { code: '84', flag: '🇻🇳', name: 'Vietnam' },
  { code: '880', flag: '🇧🇩', name: 'Bangladesh' },
  { code: '92', flag: '🇵🇰', name: 'Pakistan' },
  { code: '94', flag: '🇱🇰', name: 'Sri Lanka' },
  { code: '977', flag: '🇳🇵', name: 'Nepal' },
  { code: '95', flag: '🇲🇲', name: 'Myanmar' },
  { code: '855', flag: '🇰🇭', name: 'Cambodia' },
  { code: '856', flag: '🇱🇦', name: 'Laos' },
  { code: '673', flag: '🇧🇳', name: 'Brunei' },
  { code: '975', flag: '🇧🇹', name: 'Bhutan' },
  { code: '960', flag: '🇲🇻', name: 'Maldives' },
  { code: '993', flag: '🇹🇲', name: 'Turkmenistan' },
  { code: '998', flag: '🇺🇿', name: 'Uzbekistan' },
  { code: '996', flag: '🇰🇬', name: 'Kyrgyzstan' },
  { code: '992', flag: '🇹🇯', name: 'Tajikistan' },
  { code: '7', flag: '🇰🇿', name: 'Kazakhstan' },
  { code: '994', flag: '🇦🇿', name: 'Azerbaijan' },
  { code: '995', flag: '🇬🇪', name: 'Georgia' },
  { code: '374', flag: '🇦🇲', name: 'Armenia' },
  { code: '98', flag: '🇮🇷', name: 'Iran' },
  { code: '964', flag: '🇮🇶', name: 'Iraq' },
  { code: '963', flag: '🇸🇾', name: 'Syria' },
  { code: '961', flag: '🇱🇧', name: 'Lebanon' },
  { code: '962', flag: '🇯🇴', name: 'Jordan' },
  { code: '966', flag: '🇸🇦', name: 'Saudi Arabia' },
  { code: '971', flag: '🇦🇪', name: 'UAE' },
  { code: '974', flag: '🇶🇦', name: 'Qatar' },
  { code: '973', flag: '🇧🇭', name: 'Bahrain' },
  { code: '968', flag: '🇴🇲', name: 'Oman' },
  { code: '967', flag: '🇾🇪', name: 'Yemen' },
  { code: '965', flag: '🇰🇼', name: 'Kuwait' },
  { code: '970', flag: '🇵🇸', name: 'Palestine' },
  { code: '52', flag: '🇲🇽', name: 'Mexico' },
  { code: '55', flag: '🇧🇷', name: 'Brazil' },
  { code: '54', flag: '🇦🇷', name: 'Argentina' },
  { code: '56', flag: '🇨🇱', name: 'Chile' },
  { code: '57', flag: '🇨🇴', name: 'Colombia' },
  { code: '51', flag: '🇵🇪', name: 'Peru' },
  { code: '58', flag: '🇻🇪', name: 'Venezuela' },
  { code: '593', flag: '🇪🇨', name: 'Ecuador' },
  { code: '591', flag: '🇧🇴', name: 'Bolivia' },
  { code: '595', flag: '🇵🇾', name: 'Paraguay' },
  { code: '598', flag: '🇺🇾', name: 'Uruguay' },
  { code: '61', flag: '🇦🇺', name: 'Australia' },
  { code: '64', flag: '🇳🇿', name: 'New Zealand' },
]

export default function DS160IsraelForm({
  initialBlob = null,
  initialBlobKey = null,
  formUUID = null,
  onExitToHome = null,
} = {}) {
  /** ISO date (YYYY-MM-DD) when this form session started; used for draft/S3 id, not user-editable. */
  const formStartedDateRef = useRef(new Date().toISOString().slice(0, 10))
  /** Canonical form UUID — set from prop or restored from blob. Used as S3 prefix and blob key. */
  const formUUIDRef = useRef(formUUID || '')
  /** Blob pathname this form was loaded from; used to overwrite the same file on re-save. */
  const loadedBlobKeyRef = useRef(/** @type {string | null} */ (initialBlobKey))

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

      hasForeignCitizenship: 'no',
      foreignCitizenshipCountry: '',
      foreignCitizenshipId: '',
      visaClass: 'B1/B2',
      travelingWithOthers: 'no',
      travelCompanions: [{ fullName: '', relation: '' }],
      visitedUSBefore: 'no',
      previousUSVisits: [{ visit: '' }],
      hadUSVisa: 'no',
      lastVisaIssueDate: '',
      lastVisaExpirationDate: '',
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
      spouseAddressSame: true,
      hasUSContact: 'no',
      hasCloseRelativesInUS: 'no',
      usRelatives: [{ fullName: '', relationship: '', status: '' }],
      unemploymentReason: '',
      workedAnotherJobLast5Years: 'no',
      attendedHighSchool: 'no',
      hasAcademicDegree: 'no',
      hasAdditionalAcademicDegree: 'no',
      visitedAbroadLast5Years: 'no',
      servedInMilitary: 'no',
      criminalRecord: 'no',
      interviewLocation: 'tel_aviv',
      languages: [],
      extraDocumentsNote: '',
      phoneCountryCode: '972',
      phoneNumber: '',
      email: '',
      mondayItemId: '',
    },
  })

  const { fields: travelCompanionFields, append: appendTravelCompanion, remove: removeTravelCompanion } =
    useFieldArray({
      control,
      name: 'travelCompanions',
    })

  const { fields: previousVisitFields, append: appendPreviousVisit, remove: removePreviousVisit } =
    useFieldArray({
      control,
      name: 'previousUSVisits',
    })

  const { fields: usRelativeFields, append: appendUSRelative, remove: removeUSRelative } =
    useFieldArray({
      control,
      name: 'usRelatives',
    })

  const passportIdWatch = watch('passportId')
  const passportScanWatch = watch('passportScan')
  const photoScanWatch = watch('photoScan')
  const existingVisaScanWatch = watch('existingVisaScan')
  const socialSecurityScanWatch = watch('socialSecurityScan')
  const americanLicenseScanWatch = watch('americanLicenseScan')
  const extraDocumentScan1Watch = watch('extraDocumentScan1')
  const extraDocumentScan2Watch = watch('extraDocumentScan2')
  const extraDocumentScan3Watch = watch('extraDocumentScan3')
  const formId = useMemo(
    () => buildFormId(passportIdWatch, formStartedDateRef.current),
    [passportIdWatch],
  )
  /** Storage key: UUID if available, else passport-based id, else 'incomplete' */
  const storageFormId = useMemo(
    () => formUUIDRef.current || formId || 'incomplete',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [formId],
  )
  const [asyncFlow, setAsyncFlow] = useState({ phase: 'idle', message: '' })
  const [passportOcr, setPassportOcr] = useState({ status: 'idle', message: '' })
  const [socialSecurityOcr, setSocialSecurityOcr] = useState({ status: 'idle', message: '' })
  const [usLicenseOcr, setUsLicenseOcr] = useState({ status: 'idle', message: '' })
  const [previousVisaOcr, setPreviousVisaOcr] = useState({ status: 'idle', message: '' })
  const [i94State, setI94State] = useState({ status: 'idle', error: '', data: null })
  const [saveBeforeTranslatePrompt, setSaveBeforeTranslatePrompt] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [translateUi, setTranslateUi] = useState({
    open: false,
    text: '',
    loading: false,
    error: '',
    attachmentLabels: /** @type {string[]} */ ([]),
    pdfBase64: '',
  })

  /** Monday.com multi-step UI state (search → confirm → upload). */
  const [mondayUi, setMondayUi] = useState({
    // search phase
    searching: false,
    searchError: '',
    /** @type {{ itemId: string, itemName: string } | 'not_found' | null} */
    searchResult: null,
    // upload phase
    uploading: false,
    uploadError: '',
    uploadSuccess: false,
    uploadItemId: '',
    uploadItemUrl: '',
    uploadIsNew: false,
  })

  /** Reset Monday UI to initial state (called on modal close / new translation). */
  function resetMondayUi() {
    setMondayUi({
      searching: false, searchError: '', searchResult: null,
      uploading: false, uploadError: '', uploadSuccess: false,
      uploadItemId: '', uploadItemUrl: '', uploadIsNew: false,
    })
  }

  /** Fields that failed the "translate" pre-flight validation (Set of field names). */
  const [translationErrors, setTranslationErrors] = useState(/** @type {Set<string>} */ (new Set()))

  /** JSON snapshot of non-file form values at the time of last successful save (or initial load). */
  const lastSavedSnapshotRef = useRef(/** @type {string | null} */ (null))

  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const [exitSaving, setExitSaving] = useState(false)
  const [exitSaveError, setExitSaveError] = useState('')

  function getSerializableSnapshot() {
    const { data } = serializeFormValuesForJson(getValues())
    return JSON.stringify(data)
  }

  function hasUnsavedChanges() {
    if (lastSavedSnapshotRef.current === null) return false
    return lastSavedSnapshotRef.current !== getSerializableSnapshot()
  }

  // For brand-new forms (no saved blob), capture the default empty-state snapshot on mount
  // so any user edits will trigger the unsaved-changes warning on exit.
  useEffect(() => {
    if (initialBlob == null) {
      lastSavedSnapshotRef.current = getSerializableSnapshot()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Latest uploaded S3 keys per field — sent with translate so server can fetch bytes for GPT + PDF appendix. */
  const s3DocumentsRef = useRef(/** @type {{ field: string, key: string, bucket?: string }[]} */ ([]))

  useEffect(() => {
    const docs = initialBlob?.s3Documents
    if (Array.isArray(docs) && docs.length > 0) {
      s3DocumentsRef.current = mergeS3DocumentsByField([], docs)
    } else if (initialBlobKey != null && initialBlob != null && (!Array.isArray(docs) || docs.length === 0)) {
      s3DocumentsRef.current = []
    }
  }, [initialBlobKey, initialBlob])

  useEffect(() => {
    if (!initialBlob?.data || typeof initialBlob.data !== 'object') return
    const { passportDate: _omitBlobPd, ...data } = initialBlob.data
    // Restore the original formStartedDate so re-saves overwrite the same blob filename.
    if (typeof data.formStartedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.formStartedDate)) {
      formStartedDateRef.current = data.formStartedDate
    }
    // Restore UUID so S3/blob saves use the same key
    if (typeof data.formUUID === 'string' && data.formUUID.trim()) {
      formUUIDRef.current = data.formUUID.trim()
    }
    const companions =
      Array.isArray(data.travelCompanions) && data.travelCompanions.length > 0
        ? data.travelCompanions
        : [{ fullName: '', relation: '' }]
    // Convert legacy string previousUSVisits to array format
    let restoredVisits = data.previousUSVisits
    if (typeof restoredVisits === 'string') {
      restoredVisits = restoredVisits.split('\n').filter(Boolean).map((v) => ({ visit: v }))
    }
    if (!Array.isArray(restoredVisits) || restoredVisits.length === 0) {
      restoredVisits = [{ visit: '' }]
    }
    const resetValues = {
      ...data,
      travelCompanions: companions,
      previousUSVisits: restoredVisits,
      mondayItemId: String(data.mondayItemId || ''),
      passportScan: undefined,
      photoScan: undefined,
      existingVisaScan: undefined,
      socialSecurityScan: undefined,
      americanLicenseScan: undefined,
      extraDocumentScan1: undefined,
      extraDocumentScan2: undefined,
      extraDocumentScan3: undefined,
    }
    reset(resetValues)
    // Highlight missing fields immediately so the user sees what needs filling on open
    setTranslationErrors(validateForTranslation(resetValues))
    // Snapshot the loaded state so we can detect unsaved changes on exit
    const { data: cleanData } = serializeFormValuesForJson(resetValues)
    lastSavedSnapshotRef.current = JSON.stringify(cleanData)
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
        setAsyncFlow({ phase: 'idle', message: `שוחזרו ${restored} מסמכים${extra}.` })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initialBlobKey, initialBlob, setValue])

  function buildN8nBody(event, values, s3Documents) {
    const { data, fileMeta } = serializeFormValuesForJson(values)
    return {
      event,
      formId: storageFormId,
      clientTimestamp: new Date().toISOString(),
      schema: 'ds160_israel_form_v1',
      data: {
        ...data,
        formStartedDate: formStartedDateRef.current,
        formUUID: formUUIDRef.current || null,
      },
      fileMeta,
      s3Documents,
    }
  }

  const onSubmit = async (data) => {
    setAsyncFlow({ phase: 'working', message: '' })
    try {
      const { results: uploads, s3Disabled } = await uploadFormDocumentsToS3(storageFormId, [
        { name: 'passportScan', file: firstFile(data.passportScan) },
        { name: 'photoScan', file: firstFile(data.photoScan) },
        { name: 'existingVisaScan', file: firstFile(data.existingVisaScan) },
        { name: 'socialSecurityScan', file: firstFile(data.socialSecurityScan) },
        { name: 'americanLicenseScan', file: firstFile(data.americanLicenseScan) },
        { name: 'extraDocumentScan1', file: firstFile(data.extraDocumentScan1) },
        { name: 'extraDocumentScan2', file: firstFile(data.extraDocumentScan2) },
        { name: 'extraDocumentScan3', file: firstFile(data.extraDocumentScan3) },
      ])
      if (s3Disabled) {
        console.warn('[submit] S3 not configured — document files were NOT uploaded.')
      }
      s3DocumentsRef.current = mergeS3DocumentsByField(s3DocumentsRef.current, uploads)
      const body = buildN8nBody('submit', data, s3DocumentsRef.current)
      saveFormDraftToBrowser(storageFormId, { lastEvent: 'submit', ...body })
      try {
        const blobResult = await saveFormBlobPayload(body, loadedBlobKeyRef.current ?? undefined)
        if (blobResult?.pathname && typeof blobResult.pathname === 'string') {
          loadedBlobKeyRef.current = blobResult.pathname
        }
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
        message: e?.message || 'שגיאה בשליחת הטופס',
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
      return false
    }
    setAsyncFlow({ phase: 'working', message: '' })
    try {
      // Quick save: include already-known s3Documents so re-saves never wipe previous refs.
      const quickBody = buildN8nBody('draft', values, s3DocumentsRef.current)
      saveFormDraftToBrowser(storageFormId, { lastEvent: 'draft', ...quickBody })
      const blobResult = await saveFormBlobPayload(quickBody, loadedBlobKeyRef.current ?? undefined)
      // Store the pathname returned by the server so subsequent saves use the same key.
      if (blobResult?.pathname && typeof blobResult.pathname === 'string') {
        loadedBlobKeyRef.current = blobResult.pathname
      }
      lastSavedSnapshotRef.current = getSerializableSnapshot()
      setAsyncFlow({ phase: 'idle', message: 'Saved successfully' })
      // S3 upload runs after the success message — failures are non-blocking.
      try {
        const { results: uploads, s3Disabled } = await uploadFormDocumentsToS3(storageFormId, [
          { name: 'passportScan', file: firstFile(values.passportScan) },
          { name: 'photoScan', file: firstFile(values.photoScan) },
          { name: 'existingVisaScan', file: firstFile(values.existingVisaScan) },
          { name: 'socialSecurityScan', file: firstFile(values.socialSecurityScan) },
          { name: 'americanLicenseScan', file: firstFile(values.americanLicenseScan) },
          { name: 'extraDocumentScan1', file: firstFile(values.extraDocumentScan1) },
          { name: 'extraDocumentScan2', file: firstFile(values.extraDocumentScan2) },
          { name: 'extraDocumentScan3', file: firstFile(values.extraDocumentScan3) },
        ])
        const hasFiles = [
          values.passportScan, values.photoScan, values.existingVisaScan, values.socialSecurityScan,
          values.americanLicenseScan, values.extraDocumentScan1, values.extraDocumentScan2, values.extraDocumentScan3,
        ].some((v) => firstFile(v) instanceof File)
        if (s3Disabled && hasFiles) {
          setAsyncFlow({ phase: 'error', message: 'שמירה הצליחה, אבל קבצי הסריקה לא הועלו (נסה לשמור שוב).' })
        }
        s3DocumentsRef.current = mergeS3DocumentsByField(s3DocumentsRef.current, uploads)
        // Re-save blob with merged s3Documents (new uploads + previously known refs).
        if (uploads.length > 0) {
          const fullBody = buildN8nBody('draft', values, s3DocumentsRef.current)
          await saveFormBlobPayload(fullBody, loadedBlobKeyRef.current ?? undefined)
        }
      } catch (s3Err) {
        setAsyncFlow({ phase: 'error', message: `שמירה הצליחה, אבל העלאת הקבצים נכשלה: ${s3Err?.message || 'שגיאה'}` })
      }
      return true
    } catch (e) {
      setAsyncFlow({
        phase: 'error',
        message: e?.message || 'Save failed',
      })
      return false
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
    let restoredVisits = restData.previousUSVisits
    if (typeof restoredVisits === 'string') {
      restoredVisits = restoredVisits.split('\n').filter(Boolean).map((v) => ({ visit: v }))
    }
    if (!Array.isArray(restoredVisits) || restoredVisits.length === 0) {
      restoredVisits = [{ visit: '' }]
    }
    reset({
      ...restData,
      travelCompanions: companions,
      previousUSVisits: restoredVisits,
      passportScan: undefined,
      photoScan: undefined,
      existingVisaScan: undefined,
      socialSecurityScan: undefined,
      americanLicenseScan: undefined,
      extraDocumentScan1: undefined,
      extraDocumentScan2: undefined,
      extraDocumentScan3: undefined,
    })
    const { restored, failed } = await restoreS3DocumentsIntoForm(snap.s3Documents, setValue)
    if (Array.isArray(snap.s3Documents)) {
      s3DocumentsRef.current = mergeS3DocumentsByField([], snap.s3Documents)
    } else {
      s3DocumentsRef.current = []
    }
    const apiBase = getS3UploadApiBase()
    const hadMeta = Array.isArray(snap.s3Documents) && snap.s3Documents.length > 0
    let msg = 'טיוטה נטענה מהדפדפן.'
    if (restored > 0) {
      msg += ` שוחזרו ${restored} מסמכים.`
      if (failed > 0) msg += ` ${failed} קבצים לא הורדו.`
    } else if (hadMeta && !apiBase) {
      msg +=
        ' במצב פיתוח ללא API להעלאה — מסמכים לא שוחזרו; הגדר VITE_S3_UPLOAD_API_URL או פתח בפרודקשן.'
    } else if (hadMeta && restored === 0) {
      msg += ' מסמכים שמורים לא שוחזרו (נסה לבחור מחדש).'
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

  async function runSocialSecurityOcrFromFile(file) {
    setSocialSecurityOcr({ status: 'loading', message: '' })
    try {
      const r = await extractSocialSecurityNumberFromFile(file)
      if (r.socialSecurityNumber) {
        setValue('socialSecurityNumber', r.socialSecurityNumber, { shouldDirty: true })
        setSocialSecurityOcr({ status: 'idle', message: 'מספר סושיאל עודכן מהצילום.' })
      } else {
        setSocialSecurityOcr({ status: 'idle', message: 'לא זוהה מספר סושיאל בבירור מהתמונה.' })
      }
    } catch (e) {
      setSocialSecurityOcr({ status: 'error', message: e?.message || 'שגיאה בזיהוי כרטיס סושיאל' })
    }
  }

  async function runUsLicenseOcrFromFile(file) {
    setUsLicenseOcr({ status: 'loading', message: '' })
    try {
      const r = await extractUsLicenseFieldsFromFile(file)
      const lines = []
      if (r.licenseNumber) lines.push(`License number: ${r.licenseNumber}`)
      if (r.issuingState) lines.push(`Issuing state: ${r.issuingState}`)
      if (lines.length) {
        setValue('driversLicenseDetails', lines.join('\n'), { shouldDirty: true })
        setUsLicenseOcr({ status: 'idle', message: 'פרטי רישיון עודכנו מהצילום.' })
      } else {
        setUsLicenseOcr({ status: 'idle', message: 'לא זוהו מספר רישיון או מדינת/מחוז הנפקה (State) בבירור מהתמונה.' })
      }
    } catch (e) {
      setUsLicenseOcr({ status: 'error', message: e?.message || 'שגיאה בזיהוי רישיון נהיגה' })
    }
  }

  async function runPreviousVisaOcrFromFile(file) {
    setPreviousVisaOcr({ status: 'loading', message: '' })
    try {
      const r = await extractUsVisaDatesFromFile(file)
      let filled = 0
      if (r.issueDate) {
        setValue('lastVisaIssueDate', r.issueDate, { shouldDirty: true })
        filled += 1
      }
      if (r.expirationDate) {
        setValue('lastVisaExpirationDate', r.expirationDate, { shouldDirty: true })
        filled += 1
      }
      if (filled > 0) {
        setPreviousVisaOcr({
          status: 'idle',
          message:
            filled === 2
              ? 'תאריכי הנפקה ותפוגה עודכנו מהצילום.'
              : 'חלק מהתאריכים עודכן מהצילום (שדה אחד לא זוהה בבירור).',
        })
      } else {
        setPreviousVisaOcr({
          status: 'idle',
          message: 'לא זוהו תאריכי ויזה בבירור מהתמונה.',
        })
      }
    } catch (e) {
      setPreviousVisaOcr({ status: 'error', message: e?.message || 'שגיאה בזיהוי ויזה' })
    }
  }

  async function uploadDocumentImmediately(fieldName, file) {
    try {
      const { results: uploads, s3Disabled } = await uploadFormDocumentsToS3(storageFormId, [{ name: fieldName, file }])
      if (s3Disabled) {
        console.warn(`[upload] S3 not configured — ${fieldName} was not uploaded.`)
        return
      }
      if (uploads.length > 0) {
        s3DocumentsRef.current = mergeS3DocumentsByField(s3DocumentsRef.current, uploads)
      }
    } catch (e) {
      console.warn(`[upload] immediate upload of ${fieldName} failed:`, e?.message)
    }
  }

  /** Controlled by VITE_I94_ENABLED env var. Defaults to enabled when not set. */
  const i94Enabled = import.meta.env.VITE_I94_ENABLED !== 'false'

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
    () =>
      Array.isArray(wPreviousUSVisits) && wPreviousUSVisits.some((v) => String(v?.visit ?? '').trim()),
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
    const existingVisits = getValues('previousUSVisits')
    if (Array.isArray(existingVisits) && existingVisits.some((v) => String(v?.visit ?? '').trim())) {
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
        const visitRows = data.history
          .map((row) => ({
            visit: [row.date, row.type, row.location].map((s) => String(s ?? '').trim()).filter(Boolean).join(' — '),
          }))
          .filter((r) => r.visit)
        if (visitRows.length > 0) {
          setValue('visitedUSBefore', 'yes', { shouldDirty: true })
          setValue('previousUSVisits', visitRows, { shouldDirty: true })
        }
      }
    } catch (e) {
      setI94State({ status: 'error', error: e?.message || 'שגיאה', data: null })
    }
  }

  /** Returns a Set of field names that are blank/missing for required fields. */
  function validateForTranslation(values) {
    const missing = new Set()
    const req = (field) => {
      const v = values[field]
      if (v == null || String(v).trim() === '' || (Array.isArray(v) && v.length === 0)) {
        missing.add(field)
      }
    }

    // Always required
    req('passportId')
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
    req('passportIssuingCountry')
    req('addressStreet')
    req('addressCity')
    req('phoneCountryCode')
    req('phoneNumber')
    req('email')
    req('plannedArrivalDate')
    req('plannedStayDuration')
    req('accommodationInUS')
    req('tripFundingSource')
    req('fatherFullName')
    req('motherFullName')
    // fatherBirthDate + motherBirthDate are NOT required
    req('languages')
    req('currentOccupation')

    // Conditional
    if (values.hadPreviousName === 'yes') req('previousNameValue')
    if (values.hasForeignCitizenship === 'yes') {
      req('foreignCitizenshipCountry')
      req('foreignCitizenshipId')
    }
    if (values.visitedUSBefore === 'yes') {
      const visits = values.previousUSVisits
      if (!Array.isArray(visits) || visits.every((v) => !String(v?.visit ?? '').trim())) {
        missing.add('previousUSVisits')
      }
    }
    if (values.hadUSVisa === 'yes') {
      req('lastVisaIssueDate')
      req('lastVisaExpirationDate')
      req('visaLostOrStolen')
      req('tenPrinted')
    }
    if (values.visaRefused === 'yes') req('visaRefusalExplanation')
    if (values.deniedEntryToUS === 'yes') req('deniedEntryDetails')
    if (values.illegalStayInUS === 'yes') req('illegalStayDetails')
    if (values.appliedForGreenCard === 'yes') req('greenCardDetails')
    if (values.hasSocialSecurityNumber === 'yes') req('socialSecurityNumber')
    if (values.hasTaxpayerID === 'yes') req('taxpayerIDNumber')
    if (values.hasUSDriversLicense === 'yes') req('driversLicenseDetails')
    if (values.passportLostOrStolen === 'yes') {
      req('lostPassportWhen')
      req('lostPassportCountry')
      req('lostPassportDescription')
    }
    if (values.hasUSContact === 'yes') {
      req('contactFullName')
      req('contactPhone')
      req('contactAddress')
    }
    if (values.hasCloseRelativesInUS === 'yes') {
      const relatives = values.usRelatives || []
      if (!relatives.length || !String(relatives[0]?.fullName || '').trim()) {
        errors['usRelatives.0.fullName'] = 'שדה חובה'
      }
    }
    if (values.hasCloseRelativesInUS === 'no') req('hasOtherRelativesInUS')
    if (values.currentOccupation === 'עובד') {
      req('employerName')
      req('employerStreet')
      req('employerCity')
      req('jobTitle')
      req('employerPhone')
      req('employmentStartDate')
    }
    if (values.currentOccupation === 'סטודנט') {
      req('studentInstitutionName')
      req('studentDegree')
      req('studentStartDate')
      req('studentInstitutionPhone')
      req('studentInstitutionStreet')
      req('studentInstitutionCity')
    }
    if (values.currentOccupation === 'חייל') {
      req('militaryCountry')
      req('militaryBranch')
      req('militaryRole')
    }
    if (values.workedAnotherJobLast5Years === 'yes') {
      req('prevEmployerName')
      req('prevJobTitle')
    }
    if (values.attendedHighSchool === 'yes') req('highSchoolDetails')
    if (values.hasAcademicDegree === 'yes') {
      req('institutionName')
    }
    if (values.visitedAbroadLast5Years === 'yes') req('countriesVisitedLast5Years')
    if (values.servedInMilitary === 'yes') {
      req('milHistoryBranch')
      req('milHistoryRole')
    }

    return missing
  }

  async function handleTranslateToEnglish({ withSave = false } = {}) {
    const values = getValues()
    const missing = validateForTranslation(values)
    if (missing.size > 0) {
      setTranslationErrors(missing)
      setTranslateUi((s) => ({ ...s, loading: false, error: '' }))
      return
    }
    setTranslationErrors(new Set())
    setTranslateUi((s) => ({ ...s, loading: true, error: '' }))
    if (withSave) {
      try { await onSaveDraft() } catch { /* non-blocking */ }
    }
    try {
      const values = getValues()
      // Always translate with the current form values — never skip based on cache.
      // The cache is only used to restore the last result on page load (below).
      const { translated, attachmentLabels, pdfBase64 } = await translateFormToEnglish(values, {
        s3Documents: s3DocumentsRef.current,
      })
      // Save to cache so the result can be restored if the user refreshes.
      try {
        const fp = buildTranslationFingerprint(values)
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

  /**
   * Upload the PDF to an existing Monday item (no column changes — file only).
   * @param {string} itemId
   */
  async function handleMondayUpload(itemId) {
    if (!translateUi.pdfBase64?.trim()) return
    setMondayUi((s) => ({ ...s, uploading: true, uploadError: '' }))
    try {
      const result = await sendPdfToMonday({
        applicantName: '',
        pdfBase64: translateUi.pdfBase64,
        mondayItemId: itemId,
      })
      setValue('mondayItemId', result.itemId, { shouldDirty: true })
      setMondayUi((s) => ({
        ...s,
        uploading: false,
        uploadSuccess: true,
        uploadItemId: result.itemId,
        uploadItemUrl: result.itemUrl || '',
        uploadIsNew: false,
      }))
    } catch (e) {
      setMondayUi((s) => ({ ...s, uploading: false, uploadError: e?.message || 'העלאה נכשלה' }))
    }
  }

  /** Search for person on Monday and auto-upload PDF if found; stop with error if not found. */
  async function handleSendToMonday() {
    if (!translateUi.pdfBase64?.trim()) return
    const values = getValues()
    const phone = (String(values.phoneCountryCode || '').trim() + String(values.phoneNumber || '').trim())
    const email = String(values.email || '').trim()
    setMondayUi((s) => ({ ...s, searching: true, searchError: '', searchResult: null }))
    try {
      const result = await searchMondayItem({ phone, email })
      if (!result.found) {
        setMondayUi((s) => ({ ...s, searching: false, searchResult: 'not_found' }))
        return
      }
      setMondayUi((s) => ({ ...s, searching: false }))
      await handleMondayUpload(result.itemId)
    } catch (e) {
      setMondayUi((s) => ({ ...s, searching: false, searchError: e?.message || 'חיפוש נכשל' }))
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
    maritalStatus: watch('maritalStatus'),
    spouseAddressSame: watch('spouseAddressSame'),
    mondayItemId: watch('mondayItemId'),
    specificTravelPlans: watch('specificTravelPlans'),
  }

  const allFormValues = watch()

  function getFieldError(path) {
    if (!path) return undefined
    const rhfErr = errors
      ? path.split('.').reduce((acc, key) => (acc == null ? undefined : /** @type {Record<string, unknown>} */ (acc)[key]), /** @type {unknown} */ (errors))
      : undefined
    if (rhfErr) return rhfErr
    if (translationErrors.has(path)) return { message: 'שדה חובה' }
    return undefined
  }

  function renderTranslatedText(text) {
    const normalized = text.replace(/\n{3,}/g, '\n\n')
    const lines = normalized.split('\n')
    const HIGHLIGHT_PATTERNS = [
      /hold or have you held another nationality\?.*YES/i,
      /permanent resident of another country\?.*YES/i,
      /been in the united states\?.*YES/i,
      /been issued a u\.s\. visa\?.*YES/i,
      /refused.*visa.*YES/i,
      /denied admission.*YES/i,
      /immediate relatives in the united states\?.*YES/i,
      /other relatives in the united states\?.*YES/i,
    ]
    let inSecurity = false
    return lines.map((line, i) => {
      if (line.includes('SECURITY & BACKGROUND')) inSecurity = true
      else if (line.startsWith('🟦')) inSecurity = false
      const isHighlighted =
        HIGHLIGHT_PATTERNS.some((p) => p.test(line)) ||
        (inSecurity && /YES\s*$/.test(line))
      return isHighlighted ? (
        <mark key={i} className="bg-yellow-200 rounded px-0.5 whitespace-pre-wrap block">
          {line + '\n'}
        </mark>
      ) : (
        <span key={i} className="whitespace-pre-wrap">
          {line + '\n'}
        </span>
      )
    })
  }

  return (
    <div dir="rtl" className="min-h-screen bg-gray-100 font-sans text-right pb-10">
      <LoadingOverlay
        message={
          translateUi.loading ? 'מתרגם את הטופס… עשוי לקחת עד דקה' :
          mondayUi.uploading ? 'מעלה PDF ל-Monday…' :
          mondayUi.searching ? 'מחפש פריט ב-Monday…' :
          asyncFlow.phase === 'working' ? (asyncFlow.message || 'שומר…') :
          null
        }
      />
      <MissingFieldsPanel values={allFormValues} />

      {/* Sticky action bar */}
      <div className="sticky top-0 z-40 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-2 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-gray-600 truncate">
            {w.firstName || w.lastName
              ? `${w.firstName || ''} ${w.lastName || ''}`.trim()
              : 'DS-160'}
          </span>
          <div className="flex gap-2 shrink-0">
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
              className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              שמור טיוטה
            </button>
            {onExitToHome && (
              <button
                type="button"
                onClick={() => hasUnsavedChanges() ? setShowExitConfirm(true) : onExitToHome()}
                className="px-3 py-1.5 text-xs font-semibold rounded-md bg-white text-gray-700 hover:bg-gray-50 border border-gray-300"
              >
                ← רשימה
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto bg-white shadow-xl rounded-xl overflow-hidden mt-4">
        <form onSubmit={handleSubmit(onSubmit)} className="p-8 space-y-10">

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">שם הלקוח ומידע אישי</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:col-span-2 items-start">
                <div id="field-passportId" className="flex flex-col mb-0">
                  <label className="font-semibold mb-1 text-gray-700">מספר דרכון</label>
                  <input
                    type="text"
                    autoComplete="off"
                    {...register('passportId')}
                    className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 font-mono w-full max-w-md border ${translationErrors.has('passportId') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                    dir="ltr"
                    placeholder="למשל 201381722"
                  />
                  {translationErrors.has('passportId') && (
                    <span className="text-red-500 text-sm mt-1">שדה חובה</span>
                  )}
                  <span className="text-xs text-gray-500 mt-1">
                    מזהה טיוטה בפורמט{' '}
                    <span className="font-mono" dir="ltr">
                      מספר_YYYY-MM-DD
                    </span>
                    : התאריך הוא <strong>אוטומטית</strong> תאריך תחילת מילוי הטופס ({formStartedDateRef.current}).
                  </span>
                </div>
                <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-4">
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
                      void uploadDocumentImmediately('passportScan', f)
                    }}
                  />
                </div>
                <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="font-semibold text-gray-800">תמונת המבקש</p>
                  <p className="text-xs text-gray-600">
                    תמונת פנים ברורה של מבקש הוויזה (פורמט JPEG/PNG מומלץ).
                  </p>
                  <DocumentFileSlot
                    label="העלאת תמונה"
                    name="photoScan"
                    register={register}
                    setValue={setValue}
                    getFieldError={getFieldError}
                    watchedValue={photoScanWatch}
                    accept="image/*"
                    onFilePicked={(f) => {
                      void uploadDocumentImmediately('photoScan', f)
                    }}
                  />
                </div>
              </div>
              <FormInput register={register} getFieldError={getFieldError} label="שם פרטי (עברית)" name="firstName" dir="auto" />
              <FormInput register={register} getFieldError={getFieldError} label="שם משפחה (עברית)" name="lastName" dir="auto" />
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

              {(w.maritalStatus === 'גרוש' || w.maritalStatus === 'פרוד') && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
                    <h3 className="font-bold text-gray-800 text-base">פרטי בן זוג לשעבר</h3>
                    <FormInput register={register} getFieldError={getFieldError} label="שם מלא" name="exSpouseName" />
                    <FormInput register={register} getFieldError={getFieldError} label="עיר ומדינת לידה" name="exSpouseBirthCityCountry" />
                    <div className="flex flex-col">
                      <label className="font-semibold mb-1 text-gray-700">תאריך לידה</label>
                      <div className="flex gap-2">
                        <input type="text" {...register('exSpouseBirthDateDay')} placeholder="יום" className="rounded-md p-2 w-full border border-gray-300" />
                        <input type="text" {...register('exSpouseBirthDateMonth')} placeholder="חודש" className="rounded-md p-2 w-full border border-gray-300" />
                        <input type="text" {...register('exSpouseBirthDateYear')} placeholder="שנה" className="rounded-md p-2 w-full border border-gray-300" />
                      </div>
                    </div>
                    <FormInput register={register} getFieldError={getFieldError} label="תאריך חתונה" name="exSpouseMarriageDate" />
                    <FormInput register={register} getFieldError={getFieldError} label="במידה והתגרשו- תאריך גירושים" name="exSpouseDivorceDate" />
                    <FormInput register={register} getFieldError={getFieldError} label="במידה והתגרשו- התגרשם בישראל?" name="exSpouseDivorcedInIsrael" />
                  </div>
                  <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="האם התגרשת יותר מפעם אחת?" name="divorcedMoreThanOnce" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                </div>
              )}

              {w.maritalStatus === 'אלמן' && (
                <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
                  <h3 className="font-bold text-gray-800 text-base">פרטי בן הזוג שנפטרו</h3>
                  <FormInput register={register} getFieldError={getFieldError} label="שם מלא" name="deceasedSpouseName" />
                  <FormInput register={register} getFieldError={getFieldError} label="תאריך לידה" name="deceasedSpouseBirthDate" />
                  <FormInput register={register} getFieldError={getFieldError} label="אזרחות" name="deceasedSpouseCitizenship" />
                  <FormInput register={register} getFieldError={getFieldError} label="עיר ומדינת לידה" name="deceasedSpouseBirthCityCountry" />
                </div>
              )}

              {w.maritalStatus && w.maritalStatus !== 'רווק' && w.maritalStatus !== 'גרוש' && w.maritalStatus !== 'פרוד' && w.maritalStatus !== 'אלמן' && (
                <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
                  <h3 className="font-bold text-gray-800 text-base">פרטי בן בת הזוג</h3>
                  <FormInput register={register} getFieldError={getFieldError} label="שם בן\בת הזוג" name="spouseName" />
                  <FormInput register={register} getFieldError={getFieldError} label="עיר ומדינת לידה" name="spouseBirthCityCountry" />
                  <div className="flex flex-col">
                    <label className="font-semibold mb-1 text-gray-700">תאריך לידה</label>
                    <div className="flex gap-2">
                      <input type="text" {...register('spouseBirthDateDay')} placeholder="יום" className="rounded-md p-2 w-full border border-gray-300" />
                      <input type="text" {...register('spouseBirthDateMonth')} placeholder="חודש" className="rounded-md p-2 w-full border border-gray-300" />
                      <input type="text" {...register('spouseBirthDateYear')} placeholder="שנה" className="rounded-md p-2 w-full border border-gray-300" />
                    </div>
                  </div>
                  <FormInput register={register} getFieldError={getFieldError} label="אזרחות עיקרית" name="spouseCitizenship" />
                  <div className="col-span-full">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" {...register('spouseAddressSame')} className="w-4 h-4 rounded border-gray-300" />
                      <span className="text-sm font-medium text-gray-700">גרים באותה הכתובת</span>
                    </label>
                  </div>
                  {!w.spouseAddressSame && (
                    <FormInput register={register} getFieldError={getFieldError} label="כתובת בן/בת הזוג" name="spouseAddress" />
                  )}
                </div>
              )}

              <div id="field-birthDateDay" className="flex flex-col mb-4">
                <label className="font-semibold mb-1 text-gray-700">תאריך לידה</label>
                <div className="flex gap-2">
                  <input type="text" {...register('birthDateDay')} placeholder="יום" className={`rounded-md p-2 w-full border ${translationErrors.has('birthDateDay') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                  <input type="text" {...register('birthDateMonth')} placeholder="חודש" className={`rounded-md p-2 w-full border ${translationErrors.has('birthDateMonth') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                  <input type="text" {...register('birthDateYear')} placeholder="שנה" className={`rounded-md p-2 w-full border ${translationErrors.has('birthDateYear') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                </div>
                {(translationErrors.has('birthDateDay') || translationErrors.has('birthDateMonth') || translationErrors.has('birthDateYear')) && (
                  <span className="text-red-500 text-sm mt-1">שדה חובה — יש למלא יום, חודש ושנה</span>
                )}
              </div>


              <FormInput register={register} getFieldError={getFieldError} label="עיר לידה" name="birthCity" />
              <FormInput register={register} getFieldError={getFieldError} label="מספר תעודת הזהות" name="idNumber" />
              <FormInput register={register} getFieldError={getFieldError}
                label="מדינת הנפקת דרכון (באנגלית)"
                name="passportIssuingCountry"
                hint="ניתן למלא ידנית או לעדכן אוטומטית מזיהוי צילום הדרכון"
              />
              <FormInput register={register} getFieldError={getFieldError} label="כתובת מגורים נוכחית - רחוב" name="addressStreet" />
              <FormInput register={register} getFieldError={getFieldError} label="(מספר דירה / apt number)" name="addressApt" />
              <FormInput register={register} getFieldError={getFieldError} label="עיר" name="addressCity" />
              <div className="flex flex-col mb-4">
                <label className="font-semibold mb-1 text-gray-700">טלפון</label>
                <div className="flex gap-2 items-start" dir="ltr">
                  <div className="flex flex-col shrink-0">
                    <select
                      {...register('phoneCountryCode')}
                      className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 border h-[42px] ${getFieldError('phoneCountryCode') ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white'}`}
                      dir="ltr"
                    >
                      {COUNTRY_CODES.map((c) => (
                        <option key={`${c.flag}-${c.code}`} value={c.code}>
                          {c.flag} +{c.code} {c.name}
                        </option>
                      ))}
                    </select>
                    {getFieldError('phoneCountryCode') && <span className="text-red-500 text-sm mt-1">{getFieldError('phoneCountryCode')?.message || 'שגיאה'}</span>}
                  </div>
                  <div className="flex flex-col flex-1">
                    <input
                      type="tel"
                      {...register('phoneNumber')}
                      className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 border ${getFieldError('phoneNumber') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                      placeholder="543344505"
                      dir="ltr"
                    />
                    {getFieldError('phoneNumber') && <span className="text-red-500 text-sm mt-1">{getFieldError('phoneNumber')?.message || 'שגיאה'}</span>}
                  </div>
                </div>
                <span className="text-xs text-gray-400 mt-1">מספר ללא 0 בהתחלה</span>
              </div>
              <FormInput register={register} getFieldError={getFieldError} label="Email" name="email" type="email" />

              <FormRadioGroup register={register} getFieldError={getFieldError} label="אזרחות זרה?" name="hasForeignCitizenship" options={[{ label: 'לא', value: 'no' }, { label: 'של איזה מדינה?', value: 'yes' }]} />
              {w.hasForeignCitizenship === 'yes' && (
                <div className="grid grid-cols-1 gap-4">
                  <FormInput register={register} getFieldError={getFieldError} label="של איזה מדינה (אזרחות זרה)" name="foreignCitizenshipCountry" />
                  <FormInput
                    register={register}
                    getFieldError={getFieldError}
                    label="מספר זיהות באזרחות הזו (ת.ז. / מספר אזרחות וכו׳)"
                    name="foreignCitizenshipId"
                  />
                  <DocumentFileSlot
                    label="צילום תעודת האזרחות הזרה"
                    name="foreignCitizenshipScan"
                    register={register}
                    setValue={setValue}
                    getFieldError={getFieldError}
                    watchedValue={watch('foreignCitizenshipScan')}
                    accept="image/*,application/pdf"
                  />
                </div>
              )}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">תכנון נסיעה לארה&quot;ב</h2>
            <div className="grid grid-cols-1 gap-4">
              <FormSelect register={register} getFieldError={getFieldError} label="מטרת הנסיעה / סוג הויזה" name="visaClass" options={['B1/B2 — תיירות ועסקים', 'F1/M1 — ויזת סטודנט']} />
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
                      <FormInput register={register} getFieldError={getFieldError} label="קרבה" name={`travelCompanions.${index}.relation`} />
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
              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך תוכניות נסיעה ספציפיות?" name="specificTravelPlans" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
              {w.specificTravelPlans === 'yes' && (
                <>
                  <FormInput register={register} getFieldError={getFieldError} label="תאריך הגעה משוערת לארה״ב" name="plannedArrivalDate" hint="YYYY-MM-DD, משוער" />
                  <FormInput register={register} getFieldError={getFieldError} label="טיסת הגעה (אופציונלי)" name="arrivalFlight" hint="מספר טיסה, לדוגמה: LY007" />
                  <FormInput register={register} getFieldError={getFieldError} label="עיר הגעה בארה״ב" name="arrivalCity" hint="לדוגמה: New York" />
                  <FormInput register={register} getFieldError={getFieldError} label="תאריך עזיבה מארה״ב" name="departureDateUS" hint="YYYY-MM-DD, משוער" />
                  <FormInput register={register} getFieldError={getFieldError} label="טיסת יציאה (אופציונלי)" name="departureFlight" hint="מספר טיסה, לדוגמה: LY008" />
                  <FormInput register={register} getFieldError={getFieldError} label="עיר יציאה מארה״ב" name="departureCity" hint="לדוגמה: New York" />
                </>
              )}
              {w.specificTravelPlans === 'no' && (
                <>
                  <FormInput register={register} getFieldError={getFieldError} label="תאריך הגעה משוערת לארה״ב" name="plannedArrivalDate" hint="YYYY-MM-DD, משוער" />
                  <FormInput register={register} getFieldError={getFieldError} label="לכמה זמן?" name="plannedStayDuration" />
                </>
              )}
              <FormInput register={register} getFieldError={getFieldError} label="איפה תלון בארה״ב?" name="accommodationInUS" type="textarea" />
              <FormInput register={register} getFieldError={getFieldError} label="מי משלם בעבור מגיש הבקשה על הנסיעה?" name="tripFundingSource" />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">ויזה קודמת לארה&quot;ב</h2>
            <div className="grid grid-cols-1 gap-4">
              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אי פעם ביקרת בארה״ב?" name="visitedUSBefore" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.visitedUSBefore === 'yes' && (
                <div className="flex flex-col mb-2">
                  <div className="flex items-center justify-between mb-2">
                    <label className="font-semibold text-gray-700">בערך מתי ולכמה זמן [עד 5 אחרונות]</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => appendPreviousVisit({ visit: '' })}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-green-100 text-green-700 hover:bg-green-200 text-lg font-bold"
                        title="הוסף ביקור"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setValue('previousUSVisits', [{ visit: '' }], { shouldDirty: true })
                        }}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-orange-100 text-orange-700 hover:bg-orange-200 text-sm font-bold"
                        title="נקה הכל"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {previousVisitFields.map((field, index) => (
                      <div key={field.id} className="flex gap-2 items-center">
                        <span className="text-sm text-gray-500 font-medium shrink-0">
                          ביקור {index + 1}
                        </span>
                        <input
                          {...register(`previousUSVisits.${index}.visit`)}
                          placeholder="לדוגמה: ינואר 2020 — שלושה שבועות"
                          className={`flex-1 rounded-md p-2 border ${translationErrors.has('previousUSVisits') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                          dir="rtl"
                        />
                        {previousVisitFields.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removePreviousVisit(index)}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-yellow-100 text-yellow-700 hover:bg-yellow-200 text-sm font-bold shrink-0"
                            title="הסר ביקור"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {translationErrors.has('previousUSVisits') && (
                    <span className="text-red-500 text-sm mt-1">שדה חובה</span>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    ניתן למלא ידנית או להריץ &quot;בדוק היסטוריית כניסות&quot; (I-94) בשדה שמופיע מיד מתחת — הרשומות יועתקו לכאן אוטומטית.
                  </p>
                </div>
              )}

              {i94Enabled && <div className="rounded-lg border border-slate-200 bg-slate-50/90 p-4 space-y-3">
                <h3 className="text-lg font-bold text-gray-800">היסטוריית כניסות (I-94)</h3>
                <p className="text-sm text-gray-600">
                  צילום דרכון, ויזה קודמת, סושיאל ורישיון — מופיעים למעלה ליד השאלות הרלוונטיות.
                </p>
                {!canRunI94 && (
                  <p className="text-sm text-gray-500">
                    כדי להפעיל בדיקת I-94: מלא שם (אנגלי או עברי), תאריך לידה מלא, מספר דרכון ומדינת הנפקת הדרכון באנגלית.
                  </p>
                )}
                {canRunI94 && (
                  <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-gray-800">בדיקת I-94</p>
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
              </div>}

              <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
                <div className="flex flex-col xl:flex-row gap-4 xl:items-start xl:gap-6">
                  <div className="shrink-0 xl:min-w-[280px]">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="הייתה לך בעבר ויזה לארה״ב?" name="hadUSVisa" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                  {w.hadUSVisa === 'yes' && (
                    <div className="flex-1 min-w-0 space-y-4 rounded-lg border-r-4 border-blue-500 bg-gray-50 p-4 pr-4 pl-2">
                      <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
                        <p className="text-xs text-gray-600">
                          העלאת צילום ויזה — זיהוי אוטומטי (GPT-4o): תאריך הנפקה ותאריך תפוגה (YYYY-MM-DD כשאפשר), בלי ניחוש.
                        </p>
                        {previousVisaOcr.status === 'loading' && (
                          <p className="text-sm text-blue-600">מזהה תאריכים מהקובץ…</p>
                        )}
                        {previousVisaOcr.status === 'error' && (
                          <p className="text-sm text-red-600" role="alert">
                            {previousVisaOcr.message}
                          </p>
                        )}
                        {previousVisaOcr.status === 'idle' && previousVisaOcr.message && (
                          <p className="text-sm text-green-700">{previousVisaOcr.message}</p>
                        )}
                        <DocumentFileSlot
                          label="ויזה קודמת במידה ויש (צילום / PDF)"
                          name="existingVisaScan"
                          register={register}
                          setValue={setValue}
                          getFieldError={getFieldError}
                          watchedValue={existingVisaScanWatch}
                          accept="image/*,application/pdf"
                          onFilePicked={(f) => {
                            void runPreviousVisaOcrFromFile(f)
                            void uploadDocumentImmediately('existingVisaScan', f)
                          }}
                        />
                      </div>
                      <FormInput
                        register={register}
                        getFieldError={getFieldError}
                        label="תאריך הנפקת הויזה האחרונה"
                        name="lastVisaIssueDate"
                        hint="מומלץ YYYY-MM-DD; ניתן למלא אוטומטית מצילום הויזה"
                      />
                      <FormInput
                        register={register}
                        getFieldError={getFieldError}
                        label="תאריך תפוגת הויזה"
                        name="lastVisaExpirationDate"
                        hint="מומלץ YYYY-MM-DD; ניתן למלא אוטומטית מצילום הויזה"
                      />
                      <FormRadioGroup register={register} getFieldError={getFieldError} label="האם הויזה הקודמת שלך הונפקה בישראל?" name="visaIssuedInIsrael" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                      <FormRadioGroup register={register} getFieldError={getFieldError} label="האם הויזה שלך בוטלה או נשללה?" name="visaWasCancelled" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                      <FormRadioGroup register={register} getFieldError={getFieldError} label="האם הויזה שלך לארה״ב אי פעם אבדה או נגנבה?" name="visaLostOrStolen" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                      <FormRadioGroup register={register} getFieldError={getFieldError} label="האם עברת טביעות אצבעות של 10 אצבעות (ten-print) בארה״ב?" name="tenPrinted" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                    </div>
                  )}
                </div>
              </div>

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם סורבת בעבר לויזה לארה״ב" name="visaRefused" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.visaRefused === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="הסבר מדוע לדעתך, ובאיזה תאריך סורבת לויזה" name="visaRefusalExplanation" type="textarea" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="סורבת בעבר כניסה לארה״ב?" name="deniedEntryToUS" options={[{ label: 'לא', value: 'no' }, { label: 'מי איך ומתי', value: 'yes' }]} />
              {w.deniedEntryToUS === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="פרטי סירוב כניסה (מי, איך, מתי)" name="deniedEntryDetails" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם שהית באופן לא חוקי בארה״ב והפרת את תנאי הויזה?" name="illegalStayInUS" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.illegalStayInUS === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="פרט מדוע שהית באופן לא חוקי" name="illegalStayDetails" />}

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם בעבר הגשת בקשה לגרין קארד?" name="appliedForGreenCard" options={[{ label: 'לא', value: 'no' }, { label: 'מי איך ומתי', value: 'yes' }]} />
              {w.appliedForGreenCard === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="פרטי בקשת גרין קארד (מי, איך, מתי)" name="greenCardDetails" />}

              <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
                <div className="flex flex-col xl:flex-row gap-4 xl:items-start xl:gap-6">
                  <div className="shrink-0 xl:min-w-[300px]">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="U.S. Social Security Number (במידה וביקר בעבר)" name="hasSocialSecurityNumber" options={[{ label: 'לא', value: 'no' }, { label: 'מספר סושיאל', value: 'yes' }]} />
                  </div>
                  {w.hasSocialSecurityNumber === 'yes' && (
                    <div className="flex-1 min-w-0 space-y-4 rounded-lg border-r-4 border-blue-500 bg-gray-50 p-4 pr-4 pl-2">
                      <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
                        <p className="text-xs text-gray-600">
                          העלאת צילום — זיהוי אוטומטי (GPT-4o): מספר סושיאל בלבד, בלי ניחוש ספרות.
                        </p>
                        {socialSecurityOcr.status === 'loading' && (
                          <p className="text-sm text-blue-600">מזהה מספר מהקובץ…</p>
                        )}
                        {socialSecurityOcr.status === 'error' && (
                          <p className="text-sm text-red-600" role="alert">
                            {socialSecurityOcr.message}
                          </p>
                        )}
                        {socialSecurityOcr.status === 'idle' && socialSecurityOcr.message && (
                          <p className="text-sm text-green-700">{socialSecurityOcr.message}</p>
                        )}
                        <DocumentFileSlot
                          label="צילום Social Security Card (ארה״ב)"
                          name="socialSecurityScan"
                          register={register}
                          setValue={setValue}
                          getFieldError={getFieldError}
                          watchedValue={socialSecurityScanWatch}
                          accept="image/*,application/pdf"
                          onFilePicked={(f) => {
                            void runSocialSecurityOcrFromFile(f)
                            void uploadDocumentImmediately('socialSecurityScan', f)
                          }}
                        />
                      </div>
                      <FormInput register={register} getFieldError={getFieldError} label="מספר סושיאל סקוריטי" name="socialSecurityNumber" />
                    </div>
                  )}
                </div>
              </div>

              <FormRadioGroup register={register} getFieldError={getFieldError} label="U.S. Taxpayer ID Number (במידה וביקר בעבר)" name="hasTaxpayerID" options={[{ label: 'לא', value: 'no' }, { label: 'מה הוא המספר משלם מיסים?', value: 'yes' }]} />
              {w.hasTaxpayerID === 'yes' && <FormInput register={register} getFieldError={getFieldError} label="מספר משלם מיסים אמריקאי" name="taxpayerIDNumber" />}

              <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
                <div className="flex flex-col xl:flex-row gap-4 xl:items-start xl:gap-6">
                  <div className="shrink-0 xl:min-w-[260px]">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="היה לך רישיון נהיגה אמריקאי?" name="hasUSDriversLicense" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                  {w.hasUSDriversLicense === 'yes' && (
                    <div className="flex-1 min-w-0 space-y-4 rounded-lg border-r-4 border-blue-500 bg-gray-50 p-4 pr-4 pl-2">
                      <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
                        <p className="text-xs text-gray-600">
                          העלאת צילום — זיהוי אוטומטי (GPT-4o): מספר רישיון ומדינת/מחוז ארה״ב (State, באנגלית).
                        </p>
                        {usLicenseOcr.status === 'loading' && (
                          <p className="text-sm text-blue-600">מזהה פרטי רישיון מהקובץ…</p>
                        )}
                        {usLicenseOcr.status === 'error' && (
                          <p className="text-sm text-red-600" role="alert">
                            {usLicenseOcr.message}
                          </p>
                        )}
                        {usLicenseOcr.status === 'idle' && usLicenseOcr.message && (
                          <p className="text-sm text-green-700">{usLicenseOcr.message}</p>
                        )}
                        <DocumentFileSlot
                          label="רישיון נהיגה אמריקאי (צילום / PDF)"
                          name="americanLicenseScan"
                          register={register}
                          setValue={setValue}
                          getFieldError={getFieldError}
                          watchedValue={americanLicenseScanWatch}
                          accept="image/*,application/pdf"
                          onFilePicked={(f) => {
                            void runUsLicenseOcrFromFile(f)
                            void uploadDocumentImmediately('americanLicenseScan', f)
                          }}
                        />
                      </div>
                      <FormInput register={register} getFieldError={getFieldError} label="של איזה מדינה ומה המספר רישיון?" name="driversLicenseDetails" type="textarea" />
                    </div>
                  )}
                </div>
              </div>

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
                <FormInput register={register} getFieldError={getFieldError} label="אימייל של איש הקשר" name="contactEmail" />
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
              <FormInput register={register} getFieldError={getFieldError} label="תאריך לידה של האבא" name="fatherBirthDate" />
              <FormInput register={register} getFieldError={getFieldError} label="שם האמא" name="motherFullName" />
              <FormInput register={register} getFieldError={getFieldError} label="תאריך לידה של האמא" name="motherBirthDate" />
            </div>

            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך משפחה מקרבה ראשונה בארה״ב?" name="hasCloseRelativesInUS" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }, { label: 'יש רחוקה', value: 'distant' }]} />

            {w.hasCloseRelativesInUS === 'yes' && (
              <div className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
                <p className="font-semibold text-gray-800">קרובי משפחה מדרגה ראשונה בארה״ב</p>
                {usRelativeFields.map((field, index) => (
                  <div key={field.id} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-4 items-end border-b border-gray-200 pb-4 last:border-b-0 last:pb-0">
                    <FormInput register={register} getFieldError={getFieldError} label="שם מלא" name={`usRelatives.${index}.fullName`} />
                    <FormSelect register={register} getFieldError={getFieldError} label="קרבה אלייך" name={`usRelatives.${index}.relationship`} options={['הורה', 'אח/ות', 'ילד/ה', 'בעל/אישה']} />
                    <FormSelect register={register} getFieldError={getFieldError} label="סטטוס בארה״ב" name={`usRelatives.${index}.status`} options={['גרין קארד (LPR)', 'אזרח', 'אשרת סטודנט', 'אשרת עבודה', 'מטייל', 'אחר']} />
                    <div className="flex justify-end md:justify-start pb-1">
                      {index > 0 && (
                        <button type="button" onClick={() => removeUSRelative(index)}
                          className="text-sm text-red-600 hover:text-red-800 underline">
                          הסר
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <button type="button"
                  onClick={() => appendUSRelative({ fullName: '', relationship: '', status: '' })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                  <span aria-hidden className="text-lg leading-none">+</span>
                  הוסף קרוב משפחה
                </button>
              </div>
            )}

            {w.hasCloseRelativesInUS === 'no' && (
              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך קרובי משפחה אחרים (לא מדרגה ראשונה) בארה״ב?" name="hasOtherRelativesInUS" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
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
                <div className="col-span-full">
                  <FormInput register={register} getFieldError={getFieldError} label="תאר את תפקידך ותחומי האחריות שלך" name="jobDuties" type="textarea" />
                </div>
              </div>
            )}

            {w.currentOccupation === 'סטודנט' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">פרטים על היותך תלמיד או סטודנט</h3>
                <FormInput register={register} getFieldError={getFieldError} label="שם מוסד הלימודים" name="studentInstitutionName" />
                <FormInput register={register} getFieldError={getFieldError} label="מה התואר שנלמד" name="studentDegree" />
                <FormInput register={register} getFieldError={getFieldError} label="תאריך תחילת הלימודים" name="studentStartDate" />
                <FormInput register={register} getFieldError={getFieldError} label="טלפון מוסד הלימודים" name="studentInstitutionPhone" />
                <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב מוסד הלימודים" name="studentInstitutionStreet" />
                <FormInput register={register} getFieldError={getFieldError} label="עיר" name="studentInstitutionCity" />
                <FormInput register={register} getFieldError={getFieldError} label="הכנסה חודשית" name="studentMonthlyIncome" />
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

            {w.currentOccupation === 'מובטל' && (
              <div className="bg-gray-50 p-4 rounded border border-gray-200">
                <FormInput register={register} getFieldError={getFieldError} label="סיבת אי-העסקה (ייכתב בתרגום)" name="unemploymentReason" type="textarea" />
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
            {w.attendedHighSchool === 'yes' && (
              <div className="space-y-3 bg-gray-50 p-4 rounded border border-gray-200">
                <FormInput register={register} getFieldError={getFieldError} label="שם התיכון וכתובת" name="highSchoolDetails" type="textarea" />
                <FormSelect register={register} getFieldError={getFieldError} label="תחום לימודים" name="highSchoolFieldOfStudy" options={['תיכון', 'הכשרה מקצועית', 'אחר']} />
              </div>
            )}

            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש תואר אקדמאי?" name="hasAcademicDegree" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
            {w.hasAcademicDegree === 'yes' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">מוסד לימודים</h3>
                <FormInput register={register} getFieldError={getFieldError} label="שם מוסד הלימודים" name="institutionName" />
                <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב" name="institutionStreet" />
                <FormInput register={register} getFieldError={getFieldError} label="עיר" name="institutionCity" />
                <div className="col-span-full">
                  <FormSelect register={register} getFieldError={getFieldError} label="תחום לימודים" name="fieldOfStudy" options={['קורסים אקדמיים', 'תואר ראשון — B.A./B.S.', 'תואר שני — M.A./M.S.', 'תואר שלישי — Ph.D./Doctorate', 'תואר מקצועי — J.D./M.D./D.D.S.', 'הכשרה מקצועית', 'אחר']} />
                </div>
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

            <div id="field-languages" className={`flex flex-col mb-4 ${translationErrors.has('languages') ? 'rounded-md bg-red-50 p-2' : ''}`}>
              <label className="font-semibold mb-2 text-gray-700">שפות</label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {['עברית', 'אנגלית', 'ערבית', 'רוסית', 'ספרדית', 'צרפתית', 'אחר'].map((lang) => (
                  <label key={lang} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" value={lang} {...register('languages')} className="w-4 h-4 text-blue-600 rounded" />
                    <span>{lang}</span>
                  </label>
                ))}
              </div>
              {translationErrors.has('languages') && (
                <span className="text-red-500 text-sm mt-1">יש לסמן לפחות שפה אחת</span>
              )}
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


          {import.meta.env.VITE_EXTRA_DOCS === 'true' && (
          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">מסמכים נוספים (לא מתוכננים בטופס)</h2>
            <p className="text-sm text-gray-600">
              להעלאת מסמכים שלא מופיעים בשאלות למעלה (למשל אישורים, מכתבים, צילומים נוספים). הקבצים ייכללו בתרגום וב-PDF יחד עם שאר המסמכים.
            </p>
            <FormInput
              register={register}
              getFieldError={getFieldError}
              label="הערה קצרה על המסמכים האלה (אופציונלי)"
              name="extraDocumentsNote"
              type="textarea"
              placeholder="למשל: אישור עבודה, מכתב ממעסיק…"
            />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <DocumentFileSlot
                label="מסמך נוסף 1"
                name="extraDocumentScan1"
                register={register}
                setValue={setValue}
                getFieldError={getFieldError}
                watchedValue={extraDocumentScan1Watch}
                accept="image/*,application/pdf"
                onFilePicked={(f) => void uploadDocumentImmediately('extraDocumentScan1', f)}
              />
              <DocumentFileSlot
                label="מסמך נוסף 2"
                name="extraDocumentScan2"
                register={register}
                setValue={setValue}
                getFieldError={getFieldError}
                watchedValue={extraDocumentScan2Watch}
                accept="image/*,application/pdf"
                onFilePicked={(f) => void uploadDocumentImmediately('extraDocumentScan2', f)}
              />
              <DocumentFileSlot
                label="מסמך נוסף 3"
                name="extraDocumentScan3"
                register={register}
                setValue={setValue}
                getFieldError={getFieldError}
                watchedValue={extraDocumentScan3Watch}
                accept="image/*,application/pdf"
                onFilePicked={(f) => void uploadDocumentImmediately('extraDocumentScan3', f)}
              />
            </div>
          </section>
          )}

          <div className="pt-6 border-t flex flex-col items-end gap-2">
            {translationErrors.size > 0 && (
              <div
                className="w-full rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 text-right"
                dir="rtl"
                role="alert"
              >
                יש למלא {translationErrors.size} שד{translationErrors.size === 1 ? 'ה' : 'ות'} חובה המסומנ{translationErrors.size === 1 ? 'ות' : 'ות'} באדום לפני התרגום.
              </div>
            )}
            {asyncFlow.phase === 'working' && (
              <p className="text-sm text-blue-600">שומר…</p>
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
                  onClick={() => hasUnsavedChanges() ? setShowExitConfirm(true) : onExitToHome()}
                  className="px-6 py-2 border border-gray-400 text-gray-700 font-semibold rounded-md hover:bg-gray-50 transition"
                >
                  חזרה לרשימה
                </button>
              )}
              <button
                type="button"
                disabled={asyncFlow.phase === 'working' || translateUi.loading}
                onClick={() => {
                  const missing = validateForTranslation(getValues())
                  if (missing.size > 0) {
                    setTranslationErrors(missing)
                    const firstField = [...missing][0]
                    setTimeout(() => {
                      document.getElementById(`field-${firstField}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }, 50)
                    return
                  }
                  setSaveBeforeTranslatePrompt(true)
                }}
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

      {showExitConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-6 flex flex-col gap-4" dir="rtl">
            <h2 className="text-lg font-bold text-gray-800">שינויים שלא נשמרו</h2>
            <p className="text-sm text-gray-600">יש שינויים שלא נשמרו בטופס. האם ברצונך לשמור לפני היציאה?</p>
            {exitSaveError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{exitSaveError}</p>
            )}
            <div className="flex flex-col gap-2">
              <button
                disabled={exitSaving}
                className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                onClick={async () => {
                  setExitSaveError('')
                  setExitSaving(true)
                  const ok = await onSaveDraft()
                  setExitSaving(false)
                  if (ok) {
                    setShowExitConfirm(false)
                    onExitToHome()
                  } else {
                    const values = getValues()
                    if (!String(values.firstName || '').trim() || !String(values.lastName || '').trim()) {
                      setExitSaveError('יש למלא שם פרטי ושם משפחה בעברית כדי לשמור.')
                    } else {
                      setExitSaveError('השמירה נכשלה. נסה שוב או צא ללא שמירה.')
                    }
                  }
                }}
              >
                {exitSaving ? 'שומר…' : 'שמור וצא לרשימה'}
              </button>
              <button
                disabled={exitSaving}
                className="px-4 py-2 border border-gray-300 text-gray-700 font-semibold rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
                onClick={() => {
                  setShowExitConfirm(false)
                  setExitSaveError('')
                  onExitToHome()
                }}
              >
                צא ללא שמירה
              </button>
              <button
                disabled={exitSaving}
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-600 transition disabled:opacity-50"
                onClick={() => { setShowExitConfirm(false); setExitSaveError('') }}
              >
                ביטול — המשך עריכה
              </button>
            </div>
          </div>
        </div>
      )}

      {saveBeforeTranslatePrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-6 flex flex-col gap-4" dir="rtl">
            <h2 className="text-lg font-bold text-gray-800">לפני התרגום</h2>
            <p className="text-sm text-gray-600">האם ברצונך לשמור טיוטה לפני שמתחילים לתרגם?</p>
            <div className="flex flex-col gap-2">
              <button
                className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
                onClick={() => {
                  setSaveBeforeTranslatePrompt(false)
                  void handleTranslateToEnglish({ withSave: true })
                }}
              >
                שמור וצא לתרגום
              </button>
              <button
                className="px-4 py-2 border border-gray-300 text-gray-700 font-semibold rounded-lg hover:bg-gray-50 transition"
                onClick={() => {
                  setSaveBeforeTranslatePrompt(false)
                  void handleTranslateToEnglish({ withSave: false })
                }}
              >
                תרגם ללא שמירה
              </button>
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-600 transition"
                onClick={() => setSaveBeforeTranslatePrompt(false)}
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}

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
                {translateUi.text ? (
                  <button
                    type="button"
                    disabled={downloadingPdf}
                    className="text-sm px-3 py-1.5 rounded-md border border-blue-600 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                    onClick={async () => {
                      setDownloadingPdf(true)
                      try {
                        const { buildTranslationPdf } = await import('./lib/buildTranslationPdf.js')
                        const DOC_FIELDS = [
                          'passportScan', 'photoScan', 'existingVisaScan', 'socialSecurityScan',
                          'americanLicenseScan', 'extraDocumentScan1', 'extraDocumentScan2', 'extraDocumentScan3',
                        ]
                        const formValues = getValues()
                        const s3ApiBase = getS3UploadApiBase()
                        const binaries = (
                          await Promise.all(
                            DOC_FIELDS.map(async (field) => {
                              // Prefer in-browser File
                              const file = firstFile(formValues[field])
                              if (file) {
                                const bytes = new Uint8Array(await file.arrayBuffer())
                                return { field, fileName: file.name, mimeType: file.type || 'application/octet-stream', bytes }
                              }
                              // Fallback: fetch from S3 if we have a key
                              if (s3ApiBase) {
                                const s3Doc = s3DocumentsRef.current.find((d) => d.field === field)
                                if (s3Doc?.key) {
                                  try {
                                    const u = new URL(s3ApiBase, window.location.origin)
                                    u.searchParams.set('key', s3Doc.key)
                                    const res = await fetch(u.toString())
                                    if (res.ok) {
                                      const blob = await res.blob()
                                      const fileName = s3Doc.key.includes('/') ? s3Doc.key.slice(s3Doc.key.lastIndexOf('/') + 1) : s3Doc.key
                                      const bytes = new Uint8Array(await blob.arrayBuffer())
                                      return { field, fileName, mimeType: blob.type || 'application/octet-stream', bytes }
                                    }
                                  } catch { /* skip on error */ }
                                }
                              }
                              return null
                            })
                          )
                        ).filter(Boolean)
                        const pdfBytes = await buildTranslationPdf(translateUi.text, binaries)
                        const blob = new Blob([pdfBytes], { type: 'application/pdf' })
                        const url = URL.createObjectURL(blob)
                        const a = document.createElement('a')
                        a.href = url
                        a.download = 'ds160-english-summary.pdf'
                        a.click()
                        URL.revokeObjectURL(url)
                      } catch {
                        /* ignore */
                      } finally {
                        setDownloadingPdf(false)
                      }
                    }}
                  >
                    {downloadingPdf ? 'Generating…' : 'Download PDF'}
                  </button>
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
                    resetMondayUi()
                    setTranslateUi((s) => ({ ...s, open: false }))
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            {/* ── Monday.com integration panel ── */}
            {translateUi.pdfBase64 && (
              <div className="px-4 py-3 border-b text-sm" dir="rtl">
                <p className="font-semibold text-gray-700 mb-2">Monday.com</p>

                {/* Upload result */}
                {mondayUi.uploadSuccess ? (
                  <div className="flex flex-wrap items-center gap-2 text-green-700">
                    <span>
                      {mondayUi.uploadIsNew
                        ? <>✅ נוצר פריט חדש — מזהה: <span className="font-mono">{mondayUi.uploadItemId}</span></>
                        : <>✅ PDF נוסף לפריט — מזהה: <span className="font-mono">{mondayUi.uploadItemId}</span></>
                      }
                    </span>
                    {mondayUi.uploadItemUrl && (
                      <a href={mondayUi.uploadItemUrl} target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 underline underline-offset-2 hover:text-blue-800">
                        פתח ב-Monday ↗
                      </a>
                    )}
                  </div>
                ) : mondayUi.uploading ? (
                  <p className="text-gray-500">⏳ מעלה PDF…</p>
                ) : mondayUi.searching ? (
                  <p className="text-gray-500">🔍 מחפש…</p>
                ) : (
                  <>
                    {mondayUi.searchResult === 'not_found' ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-red-600">❌ לא נמצא הלקוח במערכת — לא ניתן לשלוח</span>
                        <button type="button"
                          className="px-2 py-1 rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 text-xs"
                          onClick={() => setMondayUi((s) => ({ ...s, searchResult: null, searchError: '' }))}>
                          נסה שוב
                        </button>
                      </div>
                    ) : (
                      <button type="button"
                        className="px-3 py-1.5 rounded-md border border-violet-600 text-violet-700 hover:bg-violet-50 font-medium"
                        onClick={() => void handleSendToMonday()}>
                        📤 שלח ל-Monday
                      </button>
                    )}

                    {mondayUi.searchError && (
                      <p className="text-red-600 mt-1">{mondayUi.searchError}</p>
                    )}
                    {mondayUi.uploadError && (
                      <p className="text-red-600 mt-1">{mondayUi.uploadError}</p>
                    )}
                  </>
                )}
              </div>
            )}
            {translateUi.attachmentLabels?.length > 0 && (
              <p className="px-4 pt-3 text-xs text-gray-600 border-b pb-2 text-left" dir="ltr">
                Analyzed documents: {translateUi.attachmentLabels.join(', ')}
              </p>
            )}
            <div className="p-4 overflow-y-auto text-sm text-gray-800 font-sans text-left">
              {renderTranslatedText(translateUi.text)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
