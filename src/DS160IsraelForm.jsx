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
import { extractForeignPassportNumber } from './lib/foreignPassportOcr.js'
import { extractSocialSecurityNumberFromFile } from './lib/socialSecurityOcr.js'
import { extractUsLicenseFieldsFromFile } from './lib/usLicenseOcr.js'
import { extractUsVisaDatesFromFile } from './lib/usVisaOcr.js'
import { fetchI94TravelHistory } from './lib/i94Lookup.js'
import { translateFormToEnglish } from './lib/translateForm.js'
import {
  buildTranslationFingerprint,
  saveTranslationCache,
} from './lib/translationCache.js'
import { restoreS3DocumentsIntoForm } from './lib/restoreFormDocumentsFromS3.js'
import { getS3UploadApiBase } from './lib/uploadFormDocuments.js'
import { sendPdfToMonday, searchMondayItem } from './lib/monday.js'
import CopyFromFormButton, { SectionCopyHeader } from './CopyFromFormButton.jsx'

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
function OptionalBadge() {
  return <span className="mr-1.5 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-normal text-gray-400 align-middle">אופציונלי</span>
}

function FormInput({ label, name, type = 'text', note, hint, placeholder, dir, register, getFieldError, optional, naGate, watch: watchFn, setValue: setVal }) {
  const fieldError = getFieldError(name)
  const naName = `${name}NA`
  const isDisabled = naGate && !!watchFn?.(naName)
  return (
    <div id={`field-${name}`} className="flex flex-col mb-4">
      <div className="flex items-center justify-between mb-1">
        <label className="font-semibold text-gray-700">{label}{optional && <OptionalBadge />}</label>
        {naGate && (
          <label className="flex items-center gap-1 text-sm text-gray-500 cursor-pointer">
            <input type="checkbox" {...register(naName)} className="rounded"
              onChange={e => { register(naName).onChange(e); if (e.target.checked) setVal?.(name, '') }} />
            לא רלוונטי
          </label>
        )}
      </div>
      {note && <span className="text-sm text-gray-500 mb-1">{note}</span>}
      {type === 'textarea' ? (
        <textarea
          {...register(name)}
          disabled={isDisabled}
          className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 border disabled:bg-gray-100 disabled:text-gray-400 ${fieldError ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
          placeholder={placeholder}
          rows={3}
          dir={dir}
        />
      ) : (
        <input
          type={type}
          {...register(name)}
          disabled={isDisabled}
          className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 border disabled:bg-gray-100 disabled:text-gray-400 ${fieldError ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
          placeholder={placeholder}
          dir={dir}
        />
      )}
      {hint && <span className="text-xs text-gray-400 mt-1">{hint}</span>}
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שגיאה בשדה'}</span>}
    </div>
  )
}


function FormRadioGroup({ label, name, options, note, register, getFieldError, optional }) {
  const fieldError = getFieldError(name)
  return (
    <div id={`field-${name}`} className={`flex flex-col mb-4 ${fieldError ? 'rounded-md bg-red-50 p-2 -mx-2' : ''}`}>
      <label className="font-semibold mb-1 text-gray-700">{label}{optional && <OptionalBadge />}</label>
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

function FormSelect({ label, name, options, register, getFieldError, optional }) {
  const fieldError = getFieldError(name)
  return (
    <div id={`field-${name}`} className="flex flex-col mb-4">
      <label className="font-semibold mb-1 text-gray-700">{label}{optional && <OptionalBadge />}</label>
      <select
        {...register(name)}
        className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 border ${fieldError ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
      >
        <option value="">בחר...</option>
        {options.map((opt) => {
          const val = typeof opt === 'object' ? opt.value : opt
          const lbl = typeof opt === 'object' ? opt.label : opt
          return <option key={val} value={val}>{lbl}</option>
        })}
      </select>
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שדה חובה'}</span>}
    </div>
  )
}

const _DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
const _MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

const COUNTRIES_BILINGUAL = [
  { he: 'אפגניסטן', en: 'Afghanistan' },
  { he: 'אלבניה', en: 'Albania' },
  { he: 'אלג\'יריה', en: 'Algeria' },
  { he: 'אנדורה', en: 'Andorra' },
  { he: 'אנגולה', en: 'Angola' },
  { he: 'אנטיגואה וברבודה', en: 'Antigua and Barbuda' },
  { he: 'ארגנטינה', en: 'Argentina' },
  { he: 'ארמניה', en: 'Armenia' },
  { he: 'אוסטרליה', en: 'Australia' },
  { he: 'אוסטריה', en: 'Austria' },
  { he: 'אזרבייג\'ן', en: 'Azerbaijan' },
  { he: 'איי בהאמה', en: 'Bahamas' },
  { he: 'בחריין', en: 'Bahrain' },
  { he: 'בנגלדש', en: 'Bangladesh' },
  { he: 'ברבדוס', en: 'Barbados' },
  { he: 'בלארוס', en: 'Belarus' },
  { he: 'בלגיה', en: 'Belgium' },
  { he: 'בליז', en: 'Belize' },
  { he: 'בנין', en: 'Benin' },
  { he: 'בהוטן', en: 'Bhutan' },
  { he: 'בוליביה', en: 'Bolivia' },
  { he: 'בוסניה והרצגובינה', en: 'Bosnia and Herzegovina' },
  { he: 'בוטסואנה', en: 'Botswana' },
  { he: 'ברזיל', en: 'Brazil' },
  { he: 'ברוניי', en: 'Brunei' },
  { he: 'בולגריה', en: 'Bulgaria' },
  { he: 'בורקינה פאסו', en: 'Burkina Faso' },
  { he: 'בורונדי', en: 'Burundi' },
  { he: 'קאבו ורדה', en: 'Cabo Verde' },
  { he: 'קמבודיה', en: 'Cambodia' },
  { he: 'קמרון', en: 'Cameroon' },
  { he: 'קנדה', en: 'Canada' },
  { he: 'הרפובליקה המרכז-אפריקאית', en: 'Central African Republic' },
  { he: 'צ\'אד', en: 'Chad' },
  { he: 'צ\'ילה', en: 'Chile' },
  { he: 'סין', en: 'China' },
  { he: 'קולומביה', en: 'Colombia' },
  { he: 'קומורוס', en: 'Comoros' },
  { he: 'קונגו', en: 'Congo' },
  { he: 'קוסטה ריקה', en: 'Costa Rica' },
  { he: 'קרואטיה', en: 'Croatia' },
  { he: 'קובה', en: 'Cuba' },
  { he: 'קפריסין', en: 'Cyprus' },
  { he: 'צ\'כיה', en: 'Czech Republic' },
  { he: 'דנמרק', en: 'Denmark' },
  { he: 'ג\'יבוטי', en: 'Djibouti' },
  { he: 'דומיניקה', en: 'Dominica' },
  { he: 'הרפובליקה הדומיניקנית', en: 'Dominican Republic' },
  { he: 'אקוודור', en: 'Ecuador' },
  { he: 'מצרים', en: 'Egypt' },
  { he: 'אל סלבדור', en: 'El Salvador' },
  { he: 'גינאה המשוונית', en: 'Equatorial Guinea' },
  { he: 'אריתריאה', en: 'Eritrea' },
  { he: 'אסטוניה', en: 'Estonia' },
  { he: 'אסוואטיני', en: 'Eswatini' },
  { he: 'אתיופיה', en: 'Ethiopia' },
  { he: 'פיג\'י', en: 'Fiji' },
  { he: 'פינלנד', en: 'Finland' },
  { he: 'צרפת', en: 'France' },
  { he: 'גאבון', en: 'Gabon' },
  { he: 'גמביה', en: 'Gambia' },
  { he: 'גאורגיה', en: 'Georgia' },
  { he: 'גרמניה', en: 'Germany' },
  { he: 'גאנה', en: 'Ghana' },
  { he: 'יוון', en: 'Greece' },
  { he: 'גרנדה', en: 'Grenada' },
  { he: 'גואטמלה', en: 'Guatemala' },
  { he: 'גינאה', en: 'Guinea' },
  { he: 'גינאה-ביסאו', en: 'Guinea-Bissau' },
  { he: 'גיאנה', en: 'Guyana' },
  { he: 'האיטי', en: 'Haiti' },
  { he: 'הונדורס', en: 'Honduras' },
  { he: 'הונגריה', en: 'Hungary' },
  { he: 'איסלנד', en: 'Iceland' },
  { he: 'הודו', en: 'India' },
  { he: 'אינדונזיה', en: 'Indonesia' },
  { he: 'איראן', en: 'Iran' },
  { he: 'עיראק', en: 'Iraq' },
  { he: 'אירלנד', en: 'Ireland' },
  { he: 'ישראל', en: 'Israel' },
  { he: 'איטליה', en: 'Italy' },
  { he: 'חוף השנהב', en: 'Ivory Coast' },
  { he: 'ג\'מייקה', en: 'Jamaica' },
  { he: 'יפן', en: 'Japan' },
  { he: 'ירדן', en: 'Jordan' },
  { he: 'קזחסטן', en: 'Kazakhstan' },
  { he: 'קניה', en: 'Kenya' },
  { he: 'קיריבאטי', en: 'Kiribati' },
  { he: 'כווית', en: 'Kuwait' },
  { he: 'קירגיזסטן', en: 'Kyrgyzstan' },
  { he: 'לאוס', en: 'Laos' },
  { he: 'לטביה', en: 'Latvia' },
  { he: 'לבנון', en: 'Lebanon' },
  { he: 'לסוטו', en: 'Lesotho' },
  { he: 'ליבריה', en: 'Liberia' },
  { he: 'לוב', en: 'Libya' },
  { he: 'ליכטנשטיין', en: 'Liechtenstein' },
  { he: 'ליטא', en: 'Lithuania' },
  { he: 'לוקסמבורג', en: 'Luxembourg' },
  { he: 'מדגסקר', en: 'Madagascar' },
  { he: 'מלאווי', en: 'Malawi' },
  { he: 'מלזיה', en: 'Malaysia' },
  { he: 'מלדיביים', en: 'Maldives' },
  { he: 'מאלי', en: 'Mali' },
  { he: 'מלטה', en: 'Malta' },
  { he: 'איי מרשל', en: 'Marshall Islands' },
  { he: 'מאוריטניה', en: 'Mauritania' },
  { he: 'מאוריציוס', en: 'Mauritius' },
  { he: 'מקסיקו', en: 'Mexico' },
  { he: 'מיקרונזיה', en: 'Micronesia' },
  { he: 'מולדובה', en: 'Moldova' },
  { he: 'מונקו', en: 'Monaco' },
  { he: 'מונגוליה', en: 'Mongolia' },
  { he: 'מונטנגרו', en: 'Montenegro' },
  { he: 'מרוקו', en: 'Morocco' },
  { he: 'מוזמביק', en: 'Mozambique' },
  { he: 'מיאנמר', en: 'Myanmar' },
  { he: 'נמיביה', en: 'Namibia' },
  { he: 'נאורו', en: 'Nauru' },
  { he: 'נפאל', en: 'Nepal' },
  { he: 'הולנד', en: 'Netherlands' },
  { he: 'ניו זילנד', en: 'New Zealand' },
  { he: 'ניקרגואה', en: 'Nicaragua' },
  { he: 'ניז\'ר', en: 'Niger' },
  { he: 'ניגריה', en: 'Nigeria' },
  { he: 'קוריאה הצפונית', en: 'North Korea' },
  { he: 'מקדוניה הצפונית', en: 'North Macedonia' },
  { he: 'נורווגיה', en: 'Norway' },
  { he: 'עומאן', en: 'Oman' },
  { he: 'פקיסטן', en: 'Pakistan' },
  { he: 'פלאו', en: 'Palau' },
  { he: 'פנמה', en: 'Panama' },
  { he: 'פפואה גינאה החדשה', en: 'Papua New Guinea' },
  { he: 'פרגוואי', en: 'Paraguay' },
  { he: 'פרו', en: 'Peru' },
  { he: 'פיליפינים', en: 'Philippines' },
  { he: 'פולין', en: 'Poland' },
  { he: 'פורטוגל', en: 'Portugal' },
  { he: 'קטר', en: 'Qatar' },
  { he: 'רומניה', en: 'Romania' },
  { he: 'רוסיה', en: 'Russia' },
  { he: 'רואנדה', en: 'Rwanda' },
  { he: 'סנט קיטס ונוויס', en: 'Saint Kitts and Nevis' },
  { he: 'סנט לוסיה', en: 'Saint Lucia' },
  { he: 'סנט וינסנט והגרנדינים', en: 'Saint Vincent and the Grenadines' },
  { he: 'סמואה', en: 'Samoa' },
  { he: 'סן מרינו', en: 'San Marino' },
  { he: 'סאו טומה ופרינסיפה', en: 'Sao Tome and Principe' },
  { he: 'ערב הסעודית', en: 'Saudi Arabia' },
  { he: 'סנגל', en: 'Senegal' },
  { he: 'סרביה', en: 'Serbia' },
  { he: 'סיישל', en: 'Seychelles' },
  { he: 'סיירה לאון', en: 'Sierra Leone' },
  { he: 'סינגפור', en: 'Singapore' },
  { he: 'סלובקיה', en: 'Slovakia' },
  { he: 'סלובניה', en: 'Slovenia' },
  { he: 'איי שלמה', en: 'Solomon Islands' },
  { he: 'סומליה', en: 'Somalia' },
  { he: 'דרום אפריקה', en: 'South Africa' },
  { he: 'קוריאה הדרומית', en: 'South Korea' },
  { he: 'דרום סודן', en: 'South Sudan' },
  { he: 'ספרד', en: 'Spain' },
  { he: 'סרי לנקה', en: 'Sri Lanka' },
  { he: 'סודן', en: 'Sudan' },
  { he: 'סורינם', en: 'Suriname' },
  { he: 'שוודיה', en: 'Sweden' },
  { he: 'שוויץ', en: 'Switzerland' },
  { he: 'סוריה', en: 'Syria' },
  { he: 'טייוואן', en: 'Taiwan' },
  { he: 'טג\'יקיסטן', en: 'Tajikistan' },
  { he: 'טנזניה', en: 'Tanzania' },
  { he: 'תאילנד', en: 'Thailand' },
  { he: 'טימור לסטה', en: 'Timor-Leste' },
  { he: 'טוגו', en: 'Togo' },
  { he: 'טונגה', en: 'Tonga' },
  { he: 'טרינידד וטובגו', en: 'Trinidad and Tobago' },
  { he: 'תוניסיה', en: 'Tunisia' },
  { he: 'טורקיה', en: 'Turkey' },
  { he: 'טורקמניסטן', en: 'Turkmenistan' },
  { he: 'טובאלו', en: 'Tuvalu' },
  { he: 'אוגנדה', en: 'Uganda' },
  { he: 'אוקראינה', en: 'Ukraine' },
  { he: 'איחוד האמירויות', en: 'United Arab Emirates' },
  { he: 'בריטניה', en: 'United Kingdom' },
  { he: 'ארצות הברית', en: 'United States' },
  { he: 'אורוגוואי', en: 'Uruguay' },
  { he: 'אוזבקיסטן', en: 'Uzbekistan' },
  { he: 'ונואטו', en: 'Vanuatu' },
  { he: 'הוותיקן', en: 'Vatican City' },
  { he: 'ונצואלה', en: 'Venezuela' },
  { he: 'וייטנאם', en: 'Vietnam' },
  { he: 'תימן', en: 'Yemen' },
  { he: 'זמביה', en: 'Zambia' },
  { he: 'זימבבואה', en: 'Zimbabwe' },
]

const LANGUAGES_BILINGUAL = [
  { he: 'עברית', en: 'HEBREW' },
  { he: 'אנגלית', en: 'ENGLISH' },
  { he: 'ערבית', en: 'ARABIC' },
  { he: 'רוסית', en: 'RUSSIAN' },
  { he: 'צרפתית', en: 'FRENCH' },
  { he: 'ספרדית', en: 'SPANISH' },
  { he: 'גרמנית', en: 'GERMAN' },
  { he: 'יידיש', en: 'YIDDISH' },
  { he: 'אמהרית', en: 'AMHARIC' },
  { he: 'פורטוגזית', en: 'PORTUGUESE' },
  { he: 'איטלקית', en: 'ITALIAN' },
  { he: 'טורקית', en: 'TURKISH' },
  { he: 'פרסית', en: 'PERSIAN' },
  { he: 'רומנית', en: 'ROMANIAN' },
  { he: 'הונגרית', en: 'HUNGARIAN' },
  { he: 'אחר', en: 'OTHER' },
]

function SearchableSelect({ label, name, options, register, setValue, watch: watchFn, getFieldError, optional, hint, placeholder }) {
  const currentValue = watchFn(name)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const selectedOption = options.find(o => o.en === currentValue)
  const displayValue = open ? query : (selectedOption?.he || currentValue || '')

  const filtered = useMemo(() => {
    if (!query) return options
    const q = query.toLowerCase()
    return options.filter(o => o.he.includes(query) || o.en.toLowerCase().includes(q))
  }, [query, options])

  function handleSelect(opt) {
    setValue(name, opt.en, { shouldDirty: true })
    setQuery('')
    setOpen(false)
  }

  const fieldError = getFieldError(name)

  return (
    <div id={`field-${name}`} className="flex flex-col mb-4 relative">
      <label className="font-semibold mb-1 text-gray-700">{label}{optional && <OptionalBadge />}</label>
      {hint && <span className="text-xs text-gray-400 mb-1">{hint}</span>}
      <input type="hidden" {...register(name)} />
      <input
        type="text"
        value={displayValue}
        dir="rtl"
        placeholder={placeholder || 'חפש...'}
        autoComplete="off"
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); setQuery('') }, 150)}
        className={`rounded-md p-2 border bg-white ${fieldError ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
      />
      {open && (
        <ul className="absolute z-50 left-0 right-0 max-h-52 overflow-y-auto bg-white border border-gray-300 rounded-b shadow-lg" style={{ top: '100%' }}>
          {filtered.length === 0
            ? <li className="px-3 py-2 text-gray-400 text-sm text-right">לא נמצאו תוצאות</li>
            : filtered.map(o => (
              <li
                key={o.en}
                onMouseDown={e => { e.preventDefault(); handleSelect(o) }}
                className={`px-3 py-2 cursor-pointer text-right text-sm hover:bg-blue-50 ${o.en === currentValue ? 'bg-blue-100 font-semibold' : ''}`}
              >
                {o.he}
              </li>
            ))
          }
        </ul>
      )}
      {fieldError && <span className="text-red-500 text-sm mt-1">{fieldError?.message || 'שדה חובה'}</span>}
    </div>
  )
}

function CountrySelect({ label, name, register, setValue, watch: watchFn, getFieldError, optional, hint }) {
  return (
    <SearchableSelect
      label={label} name={name} options={COUNTRIES_BILINGUAL}
      register={register} setValue={setValue} watch={watchFn}
      getFieldError={getFieldError} optional={optional} hint={hint}
      placeholder="חפש מדינה בעברית..."
    />
  )
}

const IDF_RANKS = [
  { he: 'טוראי', en: 'PRIVATE' },
  { he: 'רב טוראי', en: 'PRIVATE FIRST CLASS' },
  { he: 'סמל', en: 'SERGEANT' },
  { he: 'סמל ראשון', en: 'STAFF SERGEANT' },
  { he: 'רב סמל', en: 'SERGEANT FIRST CLASS' },
  { he: 'רב סמל ראשון', en: 'MASTER SERGEANT' },
  { he: 'רב סמל בכיר', en: 'CHIEF WARRANT OFFICER' },
  { he: 'רב סמל מתקדם', en: 'MASTER WARRANT OFFICER' },
  { he: 'סגן משנה', en: 'SECOND LIEUTENANT' },
  { he: 'סגן', en: 'FIRST LIEUTENANT' },
  { he: 'סרן', en: 'CAPTAIN' },
  { he: 'רב סרן', en: 'MAJOR' },
  { he: 'סגן אלוף', en: 'LIEUTENANT COLONEL' },
  { he: 'אלוף משנה', en: 'COLONEL' },
  { he: 'תת אלוף', en: 'BRIGADIER GENERAL' },
  { he: 'אלוף', en: 'MAJOR GENERAL' },
  { he: 'רב אלוף', en: 'LIEUTENANT GENERAL' },
]

const CITY_PRESETS = [
  { label: 'מיאמי', city: 'Miami', state: 'FL' },
  { label: 'ניו יורק', city: 'New York', state: 'NY' },
  { label: 'לאס וגאס', city: 'Las Vegas', state: 'NV' },
  { label: 'לוס אנג\'לס', city: 'Los Angeles', state: 'CA' },
]

function AccommodationBlock({
  register,
  watch,
  setValue,
  getFieldError,
  translationErrors,
  hasExact,
  cityPreset,
  excludePathname,
  excludeFormId,
}) {
  function handleCityPreset(e) {
    const val = e.target.value
    setValue('accommodationCityPreset', val, { shouldDirty: true })
    if (val === '__MANUAL__') {
      setValue('accommodationCity', '', { shouldDirty: true })
      setValue('accommodationState', '', { shouldDirty: true })
    } else if (val) {
      const preset = CITY_PRESETS.find((p) => p.city === val)
      if (preset) {
        setValue('accommodationCity', preset.city, { shouldDirty: true })
        setValue('accommodationState', preset.state, { shouldDirty: true })
        setValue('accommodationStreet1', 'Hotels', { shouldDirty: true })
      }
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-gray-700 pt-1.5">כתובת לינה בארה״ב</p>
        <CopyFromFormButton
          sectionId="accommodation"
          setValue={setValue}
          excludePathname={excludePathname}
          excludeFormId={excludeFormId}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="font-semibold text-sm text-gray-700">האם יש לך כתובת מדויקת?</label>
        <div className="flex gap-4">
          {[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }].map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="radio" value={opt.value} {...register('hasExactAccommodationAddress')} className="w-4 h-4 text-blue-600" />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>

      {hasExact === 'yes' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב (שורה 1)" name="accommodationStreet1" hint="לדוגמה: 9080 Sunrise Blvd" />
          <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב (שורה 2)" name="accommodationStreet2" hint="לדוגמה: Apt 4B" optional />
          <FormInput register={register} getFieldError={getFieldError} label="עיר" name="accommodationCity" />
          <FormInput register={register} getFieldError={getFieldError} label="מדינה (State)" name="accommodationState" hint="לדוגמה: FL" optional naGate watch={watch} setValue={setValue} />
          <FormInput register={register} getFieldError={getFieldError} label="מיקוד (ZIP, אם ידוע)" name="accommodationZip" optional naGate watch={watch} setValue={setValue} />
        </div>
      )}

      {hasExact === 'no' && (
        <div className="space-y-3">
          <div className="flex flex-col gap-1">
            <label className="font-semibold text-sm text-gray-700">בחר עיר</label>
            <select
              value={cityPreset || ''}
              onChange={handleCityPreset}
              className="rounded-md p-2 border border-gray-300 bg-white"
            >
              <option value="">בחר עיר...</option>
              {CITY_PRESETS.map((p) => (
                <option key={p.city} value={p.city}>{p.label}</option>
              ))}
              <option value="__MANUAL__">הזן ידנית</option>
            </select>
          </div>
          {(cityPreset === '__MANUAL__' || CITY_PRESETS.some((p) => p.city === cityPreset)) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {cityPreset === '__MANUAL__' && (
                <>
                  <FormInput register={register} getFieldError={getFieldError} label="עיר" name="accommodationCity" />
                  <FormInput register={register} getFieldError={getFieldError} label="מדינה (State)" name="accommodationState" hint="לדוגמה: FL" />
                </>
              )}
              {cityPreset !== '__MANUAL__' && (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="font-semibold text-sm text-gray-700">עיר</label>
                    <input type="text" {...register('accommodationCity')} readOnly className="rounded-md p-2 border border-gray-300 bg-gray-100" dir="ltr" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="font-semibold text-sm text-gray-700">מדינה (State)</label>
                    <input type="text" {...register('accommodationState')} readOnly className="rounded-md p-2 border border-gray-300 bg-gray-100" dir="ltr" />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Strip formal prefixes like "State of", "Republic of", "Kingdom of" from country names. */
function normalizeCountryName(name) {
  if (!name) return name
  return name.trim().replace(/^(state|republic|kingdom|sultanate|principality|democratic republic|people's republic)\s+of\s+/i, '')
}

function _parseIso(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(str ?? '').trim())
  return m
    ? { year: m[1], month: String(parseInt(m[2], 10)), day: String(parseInt(m[3], 10)) }
    : { year: '', month: '', day: '' }
}

/**
 * Date picker: select(day) + select(month) + text(year).
 *
 * Three-field mode: pass nameDay / nameMonth / nameYear (separate RHF fields, use register).
 * Single-field mode: pass name + setValue + watch; stores ISO YYYY-MM-DD in one field.
 */
function DateSelectInput({
  label, optional, hint, className,
  nameDay, nameMonth, nameYear,
  name, setValue: setVal, watch: watchFn,
  register, getFieldError, translationErrors,
}) {
  const isThreeField = !!nameDay
  const isoValue = !isThreeField ? String(watchFn?.(name) ?? '') : ''
  const init = !isThreeField ? _parseIso(isoValue) : { year: '', month: '', day: '' }

  const [lDay, setLDay] = useState(init.day)
  const [lMonth, setLMonth] = useState(init.month)
  const [lYear, setLYear] = useState(init.year)

  useEffect(() => {
    if (!isThreeField && isoValue) {
      const p = _parseIso(isoValue)
      setLYear(p.year); setLMonth(p.month); setLDay(p.day)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isoValue])

  function write(d, mo, yr) {
    if (!name || !setVal) return
    setVal(
      name,
      d && mo && yr && yr.length >= 4
        ? `${yr}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
        : '',
      { shouldDirty: true },
    )
  }

  const hasErr = isThreeField
    ? (translationErrors?.has(nameDay) || translationErrors?.has(nameMonth) || translationErrors?.has(nameYear))
    : translationErrors?.has(name)
  const err = isThreeField
    ? (getFieldError?.(nameDay) || getFieldError?.(nameMonth) || getFieldError?.(nameYear))
    : getFieldError?.(name)
  const bad = hasErr || !!err
  const selCls = `rounded-md p-2 border text-sm bg-white ${bad ? 'border-red-400 bg-red-50' : 'border-gray-300'}`
  const yrCls = `rounded-md p-2 border text-sm w-[5.5rem] ${bad ? 'border-red-400 bg-red-50' : 'border-gray-300'}`
  const id = isThreeField ? `field-${nameDay}` : `field-${name}`

  return (
    <div id={id} className={className ?? 'flex flex-col mb-4'}>
      <label className="font-semibold mb-1 text-gray-700">{label}{optional && <OptionalBadge />}</label>
      {hint && <span className="text-xs text-gray-400 mb-1">{hint}</span>}
      <div className="flex gap-2 flex-wrap">
        {isThreeField ? (
          <select {...register(nameDay)} className={selCls}>
            <option value="">יום</option>
            {_DAYS.map(d => <option key={d} value={String(d)}>{String(d).padStart(2, '0')}</option>)}
          </select>
        ) : (
          <select value={lDay} onChange={e => { const v = e.target.value; setLDay(v); write(v, lMonth, lYear) }} className={selCls}>
            <option value="">יום</option>
            {_DAYS.map(d => <option key={d} value={String(d)}>{String(d).padStart(2, '0')}</option>)}
          </select>
        )}
        {isThreeField ? (
          <select {...register(nameMonth)} className={selCls}>
            <option value="">חודש</option>
            {_MONTHS.map(m => <option key={m} value={String(m)}>{String(m).padStart(2, '0')}</option>)}
          </select>
        ) : (
          <select value={lMonth} onChange={e => { const v = e.target.value; setLMonth(v); write(lDay, v, lYear) }} className={selCls}>
            <option value="">חודש</option>
            {_MONTHS.map(m => <option key={m} value={String(m)}>{String(m).padStart(2, '0')}</option>)}
          </select>
        )}
        {isThreeField ? (
          <input type="text" {...register(nameYear)} placeholder="שנה" maxLength={4} dir="ltr" className={yrCls} />
        ) : (
          <input
            type="text"
            value={lYear}
            onChange={e => { const v = e.target.value; setLYear(v); write(lDay, lMonth, v) }}
            placeholder="שנה"
            maxLength={4}
            dir="ltr"
            className={yrCls}
          />
        )}
      </div>
      {bad && <span className="text-red-500 text-sm mt-1">{err?.message || 'שדה חובה — יש למלא יום, חודש ושנה'}</span>}
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
      passportType: 'REGULAR',
      passportBookNumberDoesNotApply: true,
      passportIssuingCountry: 'Israel',
      passportIssuingState: '',
      passportIssuingStateNA: true,
      passportIssuingCity: '',
      passportIssuingAuthority: '',
      passportIssuingAuthorityNA: true,
      mailingAddressSame: 'yes',
      travelingAsGroup: 'no',
      otherPhonesLastFiveYears: 'no',
      otherEmailsLastFiveYears: 'no',
      firstName: '',
      lastName: '',
      firstNameEnglish: '',
      lastNameEnglish: '',
      sex: '',
      hadPreviousName: 'no',
      previousNames: [{ given: '', surname: '' }],
      hasTelecode: 'no',
      telecodes: [{ given: '', surname: '' }],

      nationality: '',
      hasForeignCitizenship: 'no',
      foreignNationalities: [{ country: '', hasForeignPassport: 'no', id: '' }],
      isPermanentResidentElsewhere: 'no',
      permanentResidencies: [{ country: '' }],
      usSocialSecurityNumber: '',
      usTaxpayerId: '',
      // legacy single-entry fields kept for backward compat
      foreignCitizenshipCountry: '',
      foreignCitizenshipId: '',
      visaClass: 'B1/B2 — תיירות ועסקים',
      travelingWithOthers: 'no',
      travelCompanions: [{ surname: '', givenName: '', relationship: '' }],
      visitedUSBefore: 'no',
      previousUSVisits: [{ arrivalDate: '', stayValue: '', stayUnit: '' }],
      hasESTAPermit: false,
      hadUSVisa: 'no',
      lastVisaIssueDate: '',
      lastVisaExpirationDate: '',
      visaIssuedInIsrael: 'yes',
      sameVisaType: 'yes',
      visaNumber: '',
      visaNumberDoNotKnow: false,
      visaNoCopyAvailable: false,
      visaWasCancelled: 'no',
      visaWasCancelledExplanation: '',
      visaLostOrStolen: 'no',
      visaLostOrStolenYear: '',
      visaLostOrStolenExplanation: '',
      tenPrinted: 'no',
      refusedOrDeniedUS: 'no',
      refusedOrDeniedExplanation: '',
      immigrantPetition: 'no',
      immigrantPetitionExplanation: '',
      fatherSurnames: '',
      fatherSurnamesDoNotKnow: false,
      fatherGivenNames: '',
      fatherGivenNamesDoNotKnow: false,
      fatherBirthDateDoNotKnow: false,
      fatherInUS: 'no',
      motherSurnames: '',
      motherSurnamesDoNotKnow: false,
      motherGivenNames: '',
      motherGivenNamesDoNotKnow: false,
      motherBirthDateDoNotKnow: false,
      motherInUS: 'no',
      hasOrganizations: 'no',
      hasSpecializedSkills: 'no',
      specializedSkillsDescription: 'FIREARMS - MILITARY TRAINING',
      organizations: [],
      // legacy kept for backward compat
      visaRefused: 'no',
      deniedEntryToUS: 'no',
      illegalStayInUS: 'no',
      appliedForGreenCard: 'no',
      hasSocialSecurityNumber: 'no',
      hasTaxpayerID: 'no',
      hasUSDriversLicense: 'no',
      usDriversLicenses: [{ number: '', numberDoNotKnow: false, state: '' }],
      passportExpirationNoExpiry: false,
      passportLostOrStolen: 'no',
      lostPassports: [{ number: '', numberDoNotKnow: false, country: '', explain: '' }],
      spouseSurnames: '',
      spouseGivenNames: '',
      spouseNationality: '',
      spouseBirthCity: '',
      spouseBirthCityDoNotKnow: false,
      spouseBirthCountry: '',
      spouseBirthCountryNA: true,
      spouseAddressType: '',
      spouseAddressStreet: '',
      spouseAddressStreet2: '',
      spouseAddressCity: '',
      spouseAddressState: '',
      spouseAddressStateDoesNotApply: true,
      spouseAddressZip: '',
      spouseAddressZipDoesNotApply: true,
      spouseAddressCountry: 'Israel',
      hasUSContact: 'yes',
      hasCloseRelativesInUS: 'no',
      hasOtherRelativesInUS: 'no',
      usRelatives: [{ surnames: '', givenNames: '', relationship: '', status: '' }],
      unemploymentReason: '',
      unemploymentReasonNA: true,
      jobTitle: '',
      employerStreet2: '',
      employerState: '',
      employerStateDoesNotApply: true,
      employerZip: '',
      employerZipDoesNotApply: true,
      employerCountry: 'Israel',
      monthlySalaryDoesNotApply: false,
      workedAnotherJobLast5Years: 'no',
      previousEmployments: [{ employerName: '', street: '', street2: '', city: '', state: '', stateDoesNotApply: true, zip: '', zipDoesNotApply: true, country: 'Israel', phone: '', jobTitle: '', supervisorSurnames: '', supervisorSurnamesDoNotKnow: false, supervisorGivenNames: '', supervisorGivenNamesDoNotKnow: false, dateFrom: '', dateTo: '', duties: '' }],
      attendedHighSchool: 'no',
      hasAcademicDegree: 'no',
      additionalDegrees: [],
      hasEducation: 'no',
      educationRecords: [{ institutionName: '', street: '', street2: '', city: '', state: '', stateDoesNotApply: true, zip: '', zipDoesNotApply: true, country: 'Israel', courseOfStudy: '', dateFrom: '', dateTo: '' }],
      additionalExSpouses: [],
      numberOfFormerSpouses: '',
      formerSpouses: [{ surnames: '', givenNames: '', nationality: '', birthCity: '', birthCityDoNotKnow: false, birthCountry: '', birthCountryNA: true, marriageDate: '', marriageEndDate: '', howEnded: 'Divorce Settlement', terminationCountry: 'Israel' }],
      hasClanOrTribe: 'no',
      clanOrTribeName: '',
      languagesList: [{ name: '' }],
      visitedAbroadLast5Years: 'no',
      countriesVisited: [{ country: '' }],
      servedInMilitary: 'no',
      militaryService: [{ country: 'Israel', branch: '', rank: '', specialty: '', specialtyNA: true, dateFrom: '', dateTo: '' }],
      militaryCountry: 'Israel',
      hasParamilitary: 'no',
      paramilitaryExplanation: '',
      communicableDisease: 'no',
      communicableDiseaseExplanation: '',
      mentalDisorder: 'no',
      mentalDisorderExplanation: '',
      drugAbuser: 'no',
      drugAbuserExplanation: '',
      withheldCustody: 'no',
      withheldCustodyExplanation: '',
      votedIllegally: 'no',
      votedIllegallyExplanation: '',
      renouncedCitizenship: 'no',
      renouncedCitizenshipExplanation: '',
      immigrationFraud: 'no',
      immigrationFraudExplanation: '',
      deportedFromCountry: 'no',
      deportedFromCountryExplanation: '',
      espionage: 'no',
      espionageExplanation: '',
      terroristActivities: 'no',
      terroristActivitiesExplanation: '',
      supportedTerrorists: 'no',
      supportedTerroristsExplanation: '',
      terroristMember: 'no',
      terroristMemberExplanation: '',
      spouseOfTerrorist: 'no',
      spouseOfTerroristExplanation: '',
      genocide: 'no',
      genocideExplanation: '',
      torture: 'no',
      tortureExplanation: '',
      extrajudicialKillings: 'no',
      extrajudicialKillingsExplanation: '',
      childSoldiers: 'no',
      childSoldiersExplanation: '',
      religiousFreedomViolations: 'no',
      religiousFreedomViolationsExplanation: '',
      populationControls: 'no',
      populationControlsExplanation: '',
      organTransplantation: 'no',
      organTransplantationExplanation: '',
      arrestedOrConvicted: 'no',
      arrestedOrConvictedExplanation: '',
      violatedControlledSubstances: 'no',
      violatedControlledSubstancesExplanation: '',
      engagedInProstitution: 'no',
      engagedInProstitutionExplanation: '',
      moneyLaundering: 'no',
      moneyLaunderingExplanation: '',
      humanTrafficking: 'no',
      humanTraffickingExplanation: '',
      aidedHumanTrafficking: 'no',
      aidedHumanTraffickingExplanation: '',
      spouseOfTrafficker: 'no',
      spouseOfTraffickerExplanation: '',
      criminalRecord: 'no',
      hasSocialMedia: 'no',
      socialMediaAccounts: [{ platform: '', identifier: '' }],
      hasWebsiteContent: 'no',
      websiteContentList: [{ url: '' }],
      interviewLocation: 'tel_aviv',
      languages: [],
      extraDocumentsNote: '',
      phoneCountryCode: '972',
      phoneNumber: '',
      workPhone: '',
      otherPhones: [{ number: '' }],
      otherEmails: [{ address: '' }],
      email: '',
      // home address extra fields
      addressStreet2: '',
      addressState: '',
      addressCountry: '',
      // mailing address full structure
      mailingStreet2: '',
      mailingState: '',
      mondayItemId: '',
      hasExactAccommodationAddress: '',
      accommodationCityPreset: '',
      accommodationStreet1: '',
      accommodationStreet2: '',
      accommodationCity: '',
      accommodationState: '',
      accommodationStateNA: true,
      accommodationZip: '',
      accommodationZipNA: true,
      locationsToVisit: [{ location: '' }],
      plannedStayValue: '',
      plannedStayUnit: '',
      tripPayerType: 'SELF',
      // OTHER_PERSON fields
      tripPayerSurname: '',
      tripPayerGivenName: '',
      tripPayerPhone: '',
      tripPayerEmail: '',
      tripPayerEmailNA: true,
      tripPayerRelationship: '',
      tripPayerSameAddress: 'yes',
      tripPayerAddressStreet1: '',
      tripPayerAddressStreet2: '',
      tripPayerAddressCity: '',
      tripPayerAddressState: '',
      tripPayerAddressStateNA: true,
      tripPayerAddressZip: '',
      tripPayerAddressZipNA: true,
      tripPayerAddressCountry: '',
      // OTHER_COMPANY_ORGANIZATION fields
      tripPayerOrgName: '',
      tripPayerOrgRelationship: '',
      // legacy kept for backward compat
      selfPaying: 'yes',
      tripPayerFullName: '',
      tripPayerStreet: '',
      tripPayerCity: '',
      tripPayerCountry: '',
      contactSurnames: '',
      contactGivenNames: '',
      contactNameDoNotKnow: false,
      contactOrganization: '',
      contactOrganizationDoNotKnow: false,
      contactStreet: '',
      contactStreet2: '',
      contactCity: '',
      contactState: '',
      contactZip: '',
      contactZipNA: true,
      contactEmailDoesNotApply: false,
      arrivalFlight: '',
      arrivalFlightNA: true,
      departureFlight: '',
      departureFlightNA: true,
      jobDuties: '',
      studentDegree: '',
      studentMonthlyIncome: '',
      studentMonthlyIncomeNA: true,
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

  const { fields: additionalDegreeFields, append: appendAdditionalDegree, remove: removeAdditionalDegree } =
    useFieldArray({
      control,
      name: 'additionalDegrees',
    })

  const { fields: additionalExSpouseFields, append: appendAdditionalExSpouse, remove: removeAdditionalExSpouse } =
    useFieldArray({
      control,
      name: 'additionalExSpouses',
    })

  const { fields: formerSpouseFields, append: appendFormerSpouse, remove: removeFormerSpouse } =
    useFieldArray({
      control,
      name: 'formerSpouses',
    })

  const { fields: organizationFields, append: appendOrganization, remove: removeOrganization } =
    useFieldArray({
      control,
      name: 'organizations',
    })

  const { fields: locationFields, append: appendLocation, remove: removeLocation } =
    useFieldArray({
      control,
      name: 'locationsToVisit',
    })

  const { fields: otherPhoneFields, append: appendOtherPhone, remove: removeOtherPhone } =
    useFieldArray({ control, name: 'otherPhones' })

  const { fields: otherEmailFields, append: appendOtherEmail, remove: removeOtherEmail } =
    useFieldArray({ control, name: 'otherEmails' })

  const { fields: socialMediaAccountFields, append: appendSocialMediaAccount, remove: removeSocialMediaAccount } =
    useFieldArray({ control, name: 'socialMediaAccounts' })

  const { fields: websiteContentFields, append: appendWebsiteContent, remove: removeWebsiteContent } =
    useFieldArray({ control, name: 'websiteContentList' })

  const { fields: previousNameFields, append: appendPreviousName, remove: removePreviousName } =
    useFieldArray({
      control,
      name: 'previousNames',
    })

  const { fields: telecodeFields, append: appendTelecode, remove: removeTelecode } =
    useFieldArray({
      control,
      name: 'telecodes',
    })

  const { fields: foreignNationalityFields, append: appendForeignNationality, remove: removeForeignNationality } =
    useFieldArray({
      control,
      name: 'foreignNationalities',
    })

  const { fields: permanentResidencyFields, append: appendPermanentResidency, remove: removePermanentResidency } =
    useFieldArray({
      control,
      name: 'permanentResidencies',
    })

  const { fields: usDriversLicenseFields, append: appendUSDriversLicense, remove: removeUSDriversLicense } =
    useFieldArray({
      control,
      name: 'usDriversLicenses',
    })

  const { fields: lostPassportFields, append: appendLostPassport, remove: removeLostPassport } =
    useFieldArray({
      control,
      name: 'lostPassports',
    })

  const { fields: previousEmploymentFields, append: appendPreviousEmployment, remove: removePreviousEmployment } =
    useFieldArray({
      control,
      name: 'previousEmployments',
    })

  const { fields: educationRecordFields, append: appendEducationRecord, remove: removeEducationRecord } =
    useFieldArray({
      control,
      name: 'educationRecords',
    })

  const { fields: languagesListFields, append: appendLanguage, remove: removeLanguage } =
    useFieldArray({ control, name: 'languagesList' })

  const { fields: countriesVisitedFields, append: appendCountryVisited, remove: removeCountryVisited } =
    useFieldArray({ control, name: 'countriesVisited' })

  const { fields: militaryServiceFields, append: appendMilitaryService, remove: removeMilitaryService } =
    useFieldArray({ control, name: 'militaryService' })

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
  const [foreignPassportOcr, setForeignPassportOcr] = useState({}) // keyed by index
  const [socialSecurityOcr, setSocialSecurityOcr] = useState({ status: 'idle', message: '' })
  const [securitySectionOpen, setSecuritySectionOpen] = useState(false)
  const WORK_OCCUPATIONS = ['AGRICULTURE','ARTIST/PERFORMER','BUSINESS','COMMUNICATIONS','COMPUTER SCIENCE','CULINARY/FOOD SERVICES','EDUCATION','ENGINEERING','GOVERNMENT','LEGAL PROFESSION','MEDICAL/HEALTH','MILITARY','NATURAL SCIENCE','PHYSICAL SCIENCES','RELIGIOUS VOCATION','RESEARCH','SOCIAL SCIENCE','OTHER']
  const [occupationCategory, setOccupationCategory] = useState(() => {
    const v = watch('currentOccupation')
    return WORK_OCCUPATIONS.includes(v) ? '__WORKING__' : (v || '')
  })
  const [usLicenseOcr, setUsLicenseOcr] = useState({ status: 'idle', message: '' })
  const [previousVisaOcr, setPreviousVisaOcr] = useState({ status: 'idle', message: '' })
  const [i94State, setI94State] = useState({ status: 'idle', error: '', data: null })
  const i94AutoRanRef = useRef(false)
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
        : [{ surname: '', givenName: '', relationship: '' }]
    // Convert legacy string previousUSVisits to array format
    let restoredVisits = data.previousUSVisits
    if (typeof restoredVisits === 'string') {
      restoredVisits = restoredVisits.split('\n').filter(Boolean).map((v) => ({ arrivalDate: v, stayValue: '', stayUnit: '' }))
    }
    if (!Array.isArray(restoredVisits) || restoredVisits.length === 0) {
      restoredVisits = [{ arrivalDate: '', stayValue: '', stayUnit: '' }]
    }
    // migrate legacy { visit: '...' } entries to new structured format
    restoredVisits = restoredVisits.map((v) => {
      if (v && typeof v.visit === 'string') return { arrivalDate: v.visit, stayValue: '', stayUnit: '' }
      return { arrivalDate: v?.arrivalDate ?? '', stayValue: v?.stayValue ?? '', stayUnit: v?.stayUnit ?? '' }
    })
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
        : [{ surname: '', givenName: '', relationship: '' }]
    let restoredVisits = restData.previousUSVisits
    if (typeof restoredVisits === 'string') {
      restoredVisits = restoredVisits.split('\n').filter(Boolean).map((v) => ({ arrivalDate: v, stayValue: '', stayUnit: '' }))
    }
    if (!Array.isArray(restoredVisits) || restoredVisits.length === 0) {
      restoredVisits = [{ arrivalDate: '', stayValue: '', stayUnit: '' }]
    }
    restoredVisits = restoredVisits.map((v) => {
      if (v && typeof v.visit === 'string') return { arrivalDate: v.visit, stayValue: '', stayUnit: '' }
      return { arrivalDate: v?.arrivalDate ?? '', stayValue: v?.stayValue ?? '', stayUnit: v?.stayUnit ?? '' }
    })
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
      const effectiveIssuingCountry = normalizeCountryName(r.issuanceCountry || r.issuingCountry)
      if (effectiveIssuingCountry) setValue('passportIssuingCountry', effectiveIssuingCountry, { shouldDirty: true })
      if (r.issuanceCity) setValue('passportIssuingCity', r.issuanceCity, { shouldDirty: true })
      if (r.issuingCountry) setValue('nationality', r.issuingCountry, { shouldDirty: true })
      if (r.passportIssueDate) setValue('passportIssueDate', r.passportIssueDate, { shouldDirty: true })
      if (r.passportExpirationDate) setValue('passportExpirationDate', r.passportExpirationDate, { shouldDirty: true })
      if (r.sex === 'M') setValue('sex', 'male', { shouldDirty: true })
      else if (r.sex === 'F') setValue('sex', 'female', { shouldDirty: true })
      if (r.nationalId) setValue('idNumber', r.nationalId, { shouldDirty: true })
      if (r.passportBookNumber) setValue('passportBookNumber', r.passportBookNumber, { shouldDirty: true })
      else setValue('passportBookNumber', '', { shouldDirty: true })
      setPassportOcr({ status: 'idle', message: 'שדות דרכון עודכנו מהצילום.' })
    } catch (e) {
      setPassportOcr({ status: 'error', message: e?.message || 'שגיאה בזיהוי דרכון' })
    }
  }

  async function runForeignPassportOcrFromFile(file, index) {
    setForeignPassportOcr(prev => ({ ...prev, [index]: { status: 'loading', message: '' } }))
    try {
      const r = await extractForeignPassportNumber(file)
      if (r.passportNumber) {
        setValue(`foreignNationalities.${index}.id`, r.passportNumber, { shouldDirty: true })
        if (watch(`foreignNationalities.${index}.hasForeignPassport`) !== 'yes') {
          setValue(`foreignNationalities.${index}.hasForeignPassport`, 'yes', { shouldDirty: true })
        }
        setForeignPassportOcr(prev => ({ ...prev, [index]: { status: 'idle', message: 'מספר דרכון זוהה ועודכן.' } }))
      } else {
        setForeignPassportOcr(prev => ({ ...prev, [index]: { status: 'idle', message: 'לא זוהה מספר דרכון — הזן ידנית.' } }))
      }
    } catch (e) {
      setForeignPassportOcr(prev => ({ ...prev, [index]: { status: 'error', message: e?.message || 'שגיאה בזיהוי דרכון' } }))
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
      if (r.visaNumber) {
        setValue('visaNumber', r.visaNumber, { shouldDirty: true })
        setValue('visaNumberDoNotKnow', false, { shouldDirty: true })
        filled += 1
      }
      if (filled > 0) {
        setPreviousVisaOcr({
          status: 'idle',
          message: 'פרטי הויזה עודכנו מהצילום.',
        })
      } else {
        setPreviousVisaOcr({
          status: 'idle',
          message: 'לא זוהו פרטי ויזה בבירור מהתמונה.',
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
      Array.isArray(wPreviousUSVisits) && wPreviousUSVisits.some((v) =>
        String(v?.visit ?? '').trim() || String(v?.arrivalDate ?? '').trim()
      ),
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

  /** Parse MM/DD/YYYY or YYYY-MM-DD into a Date (returns null on failure) */
  function parseI94Date(str) {
    if (!str) return null
    // MM/DD/YYYY
    const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (mdy) return new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]))
    // YYYY-MM-DD
    const ymd = str.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    return null
  }

  /** Format a duration in milliseconds into a human-readable stay length */
  function formatStayDuration(ms) {
    const days = Math.round(ms / 86_400_000)
    if (days <= 0) return 'less than a day'
    if (days === 1) return '1 day'
    if (days < 14) return `${days} days`
    if (days < 45) return `${Math.round(days / 7)} weeks`
    const months = Math.round(days / 30.44)
    return months === 1 ? '1 month' : `${months} months`
  }

  /**
   * Convert raw I-94 history into DS-160 visit strings.
   * Pairs each Arrival with the next Departure to compute Length of Stay.
   * Format: "Arrival Date: MM/DD/YYYY · Length of Stay: X months"
   */
  function computeVisitStrings(history) {
    if (!Array.isArray(history) || history.length === 0) return []

    const arrivals = history.filter((h) => /arriv|admit|entry/i.test(String(h?.type ?? '')))
    const departures = history.filter((h) => /depart|exit/i.test(String(h?.type ?? '')))

    // If we can't distinguish arrivals/departures, fall back to all rows
    const rows = arrivals.length > 0 ? arrivals : history

    return rows.map((row) => {
      const arrDate = parseI94Date(String(row?.date ?? ''))
      let stayValue = ''
      let stayUnit = ''
      if (arrDate) {
        const nextDep = departures
          .map((d) => parseI94Date(String(d?.date ?? '')))
          .filter((d) => d && d > arrDate)
          .sort((a, b) => a - b)[0]
        if (nextDep) {
          const days = Math.round((nextDep - arrDate) / 86_400_000)
          if (days >= 365) { stayValue = String(Math.round(days / 365)); stayUnit = 'YEARS' }
          else if (days >= 30) { stayValue = String(Math.round(days / 30)); stayUnit = 'MONTHS' }
          else if (days >= 7) { stayValue = String(Math.round(days / 7)); stayUnit = 'WEEKS' }
          else { stayValue = String(days); stayUnit = 'DAYS' }
        }
      }
      const isoDate = arrDate
        ? `${arrDate.getFullYear()}-${String(arrDate.getMonth() + 1).padStart(2, '0')}-${String(arrDate.getDate()).padStart(2, '0')}`
        : String(row?.date ?? '').trim()
      return { arrivalDate: isoDate, stayValue, stayUnit }
    }).filter((r) => r.arrivalDate)
  }

  /** Auto-trigger once when all required fields are present */
  useEffect(() => {
    if (!i94Enabled) return
    if (i94AutoRanRef.current) return
    if (!canRunI94) return
    const existingVisits = getValues('previousUSVisits')
    if (Array.isArray(existingVisits) && existingVisits.some((v) => String(v?.visit ?? '').trim() || String(v?.arrivalDate ?? '').trim())) return
    i94AutoRanRef.current = true
    void handleI94Lookup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRunI94])

  async function handleI94Lookup() {
    const existingVisits = getValues('previousUSVisits')
    if (Array.isArray(existingVisits) && existingVisits.some((v) => String(v?.visit ?? '').trim() || String(v?.arrivalDate ?? '').trim())) {
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
        const visitRows = computeVisitStrings(data.history)
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
      const v = field.includes('.')
        ? field.split('.').reduce((acc, key) => (acc == null ? undefined : /** @type {Record<string, unknown>} */ (acc)[key]), /** @type {unknown} */ (values))
        : values[field]
      if (v == null || String(v).trim() === '' || (Array.isArray(v) && v.length === 0)) {
        missing.add(field)
      }
    }

    // Always required
    req('passportId')

    // ── Card 1: Personal information ──
    req('firstName')
    req('lastName')
    req('firstNameEnglish')
    req('lastNameEnglish')
    req('hadPreviousName')
    req('hasTelecode')
    req('sex')
    req('maritalStatus')

    // Marital status sub-fields
    const ms = values.maritalStatus
    if (ms === 'גרוש' || ms === 'פרוד') {
      req('numberOfFormerSpouses')
      const formerSpouses = values.formerSpouses || []
      formerSpouses.forEach((fs, i) => {
        if (!String(fs?.surnames ?? '').trim()) missing.add(`formerSpouses.${i}.surnames`)
        if (!String(fs?.givenNames ?? '').trim()) missing.add(`formerSpouses.${i}.givenNames`)
        if (!String(fs?.birthDate ?? '').trim()) missing.add(`formerSpouses.${i}.birthDate`)
        if (!String(fs?.nationality ?? '').trim()) missing.add(`formerSpouses.${i}.nationality`)
        if (!fs?.birthCityDoNotKnow && !String(fs?.birthCity ?? '').trim()) missing.add(`formerSpouses.${i}.birthCity`)
        if (!String(fs?.marriageDate ?? '').trim()) missing.add(`formerSpouses.${i}.marriageDate`)
        if (!String(fs?.marriageEndDate ?? '').trim()) missing.add(`formerSpouses.${i}.marriageEndDate`)
        if (!String(fs?.howEnded ?? '').trim()) missing.add(`formerSpouses.${i}.howEnded`)
        if (!String(fs?.terminationCountry ?? '').trim()) missing.add(`formerSpouses.${i}.terminationCountry`)
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
      req('spouseGivenNames')
      req('spouseNationality')
      req('spouseBirthDateDay')
      req('spouseBirthDateMonth')
      req('spouseBirthDateYear')
      req('spouseAddressType')
      if (values.spouseAddressType === 'OTHER (SPECIFY ADDRESS)') {
        req('spouseAddressStreet')
        req('spouseAddressCity')
        req('spouseAddressCountry')
      }
    }

    req('birthDateDay')
    req('birthDateMonth')
    req('birthDateYear')
    req('birthCity')
    req('birthCountry')

    // ── Card 2: Citizenship ──
    req('nationality')
    req('idNumber')
    req('hasForeignCitizenship')
    req('isPermanentResidentElsewhere')

    // ── Card 3: Passport ──
    req('passportIssuingCountry')
    req('passportIssuingCity')
    req('passportType')
    req('passportIssueDate')
    req('passportExpirationDate')
    req('addressStreet')
    req('addressCity')
    req('addressCountry')
    req('phoneCountryCode')
    req('phoneNumber')
    req('email')
    req('specificTravelPlans')
    req('plannedArrivalDate')
    if (values.specificTravelPlans === 'yes') {
      req('departureDateUS')
      req('arrivalCity')
      req('departureCity')
      req('accommodationStreet1')
      req('accommodationCity')
      const locs = values.locationsToVisit || []
      if (!locs.length || locs.every((l) => !String(l?.location || '').trim())) {
        missing.add('locationsToVisit.0.location')
      }
    } else {
      req('plannedStayValue')
      req('plannedStayUnit')
      req('accommodationStreet1')
      req('accommodationCity')
    }
    req('tripPayerType')
    const ptype = values.tripPayerType
    if (ptype === 'OTHER_PERSON') {
      req('tripPayerSurname')
      req('tripPayerGivenName')
      req('tripPayerPhone')
      req('tripPayerRelationship')
      if (values.tripPayerSameAddress === 'no') {
        req('tripPayerAddressStreet1')
        req('tripPayerAddressCity')
        req('tripPayerAddressCountry')
      }
    }
    if (ptype === 'OTHER_COMPANY_ORGANIZATION') {
      req('tripPayerOrgName')
      req('tripPayerPhone')
      req('tripPayerOrgRelationship')
      req('tripPayerAddressStreet1')
      req('tripPayerAddressCity')
      req('tripPayerAddressCountry')
    }
    // Father: require at least surnames or given names (unless Do Not Know)
    if (!values.fatherSurnamesDoNotKnow && !String(values.fatherSurnames ?? '').trim() &&
        !values.fatherGivenNamesDoNotKnow && !String(values.fatherGivenNames ?? '').trim()) {
      missing.add('fatherSurnames')
    }
    // Mother: same rule
    if (!values.motherSurnamesDoNotKnow && !String(values.motherSurnames ?? '').trim() &&
        !values.motherGivenNamesDoNotKnow && !String(values.motherGivenNames ?? '').trim()) {
      missing.add('motherSurnames')
    }
    // fatherBirthDate + motherBirthDate are NOT required
    if (values.fatherInUS === 'yes') req('fatherUSStatus')
    if (values.motherInUS === 'yes') req('motherUSStatus')
    // at least one language must be provided; every added entry must have a name
    const langs = values.languagesList || []
    if (!langs.some(l => String(l?.name ?? '').trim())) {
      missing.add('languagesList.0.name')
    } else {
      langs.forEach((l, i) => {
        if (!String(l?.name ?? '').trim()) missing.add(`languagesList.${i}.name`)
      })
    }
    req('currentOccupation')
    if (values.hasOrganizations === 'yes') {
      const orgs = values.organizations || []
      if (!orgs.length || !String(orgs[0]?.name || '').trim()) missing.add('organizations.0.name')
    }

    // Conditional
    if (values.hadPreviousName === 'yes') {
      const names = values.previousNames || []
      names.forEach((n, i) => {
        if (!String(n?.given || '').trim() && !String(n?.surname || '').trim()) {
          missing.add(`previousNames.${i}.given`)
        }
      })
      if (!names.length) missing.add('previousNames.0.given')
    }
    if (values.hasTelecode === 'yes') {
      const codes = values.telecodes || []
      codes.forEach((t, i) => {
        if (!String(t?.given || '').trim() && !String(t?.surname || '').trim()) {
          missing.add(`telecodes.${i}.given`)
        }
      })
      if (!codes.length) missing.add('telecodes.0.given')
    }
    if (values.hasForeignCitizenship === 'yes') {
      const fns = values.foreignNationalities || []
      fns.forEach((fn, i) => {
        if (!String(fn?.country || '').trim()) missing.add(`foreignNationalities.${i}.country`)
      })
      if (!fns.length) missing.add('foreignNationalities.0.country')
    }
    if (values.isPermanentResidentElsewhere === 'yes') {
      const prs = values.permanentResidencies || []
      prs.forEach((pr, i) => {
        if (!String(pr?.country || '').trim()) missing.add(`permanentResidencies.${i}.country`)
      })
      if (!prs.length) missing.add('permanentResidencies.0.country')
    }
    if (values.visitedUSBefore === 'yes') {
      const visits = values.previousUSVisits
      if (!Array.isArray(visits) || visits.every((v) => !String(v?.visit ?? '').trim() && !String(v?.arrivalDate ?? '').trim())) {
        missing.add('previousUSVisits')
      } else {
        visits.forEach((v, i) => {
          if (!String(v?.arrivalDate ?? '').trim()) missing.add(`previousUSVisits.${i}.arrivalDate`)
          if (!String(v?.stayValue ?? '').trim()) missing.add(`previousUSVisits.${i}.stayValue`)
          if (!String(v?.stayUnit ?? '').trim()) missing.add(`previousUSVisits.${i}.stayUnit`)
        })
      }
    }
    if (values.travelingWithOthers === 'yes') {
      const companions = values.travelCompanions || []
      companions.forEach((c, i) => {
        if (!String(c?.surname ?? '').trim() && !String(c?.givenName ?? '').trim()) {
          missing.add(`travelCompanions.${i}.surname`)
        }
        if (!String(c?.relationship ?? '').trim()) missing.add(`travelCompanions.${i}.relationship`)
      })
    }
    if (values.hadUSVisa === 'yes') {
      if (!values.visaNumberDoNotKnow) req('visaNumber')
      req('lastVisaIssueDate')
      req('sameVisaType')
      req('tenPrinted')
      if (values.visaWasCancelled === 'yes') req('visaWasCancelledExplanation')
      if (values.visaLostOrStolen === 'yes') {
        req('visaLostOrStolenYear')
        req('visaLostOrStolenExplanation')
      }
    }
    if (values.refusedOrDeniedUS === 'yes') req('refusedOrDeniedExplanation')
    if (values.immigrantPetition === 'yes') req('immigrantPetitionExplanation')
    if (values.communicableDisease === 'yes') req('communicableDiseaseExplanation')
    if (values.mentalDisorder === 'yes') req('mentalDisorderExplanation')
    if (values.drugAbuser === 'yes') req('drugAbuserExplanation')
    if (values.withheldCustody === 'yes') req('withheldCustodyExplanation')
    if (values.votedIllegally === 'yes') req('votedIllegallyExplanation')
    if (values.renouncedCitizenship === 'yes') req('renouncedCitizenshipExplanation')
    if (values.immigrationFraud === 'yes') req('immigrationFraudExplanation')
    if (values.deportedFromCountry === 'yes') req('deportedFromCountryExplanation')
    if (values.espionage === 'yes') req('espionageExplanation')
    if (values.terroristActivities === 'yes') req('terroristActivitiesExplanation')
    if (values.supportedTerrorists === 'yes') req('supportedTerroristsExplanation')
    if (values.terroristMember === 'yes') req('terroristMemberExplanation')
    if (values.spouseOfTerrorist === 'yes') req('spouseOfTerroristExplanation')
    if (values.genocide === 'yes') req('genocideExplanation')
    if (values.torture === 'yes') req('tortureExplanation')
    if (values.extrajudicialKillings === 'yes') req('extrajudicialKillingsExplanation')
    if (values.childSoldiers === 'yes') req('childSoldiersExplanation')
    if (values.religiousFreedomViolations === 'yes') req('religiousFreedomViolationsExplanation')
    if (values.populationControls === 'yes') req('populationControlsExplanation')
    if (values.organTransplantation === 'yes') req('organTransplantationExplanation')
    if (values.arrestedOrConvicted === 'yes') req('arrestedOrConvictedExplanation')
    if (values.violatedControlledSubstances === 'yes') req('violatedControlledSubstancesExplanation')
    if (values.engagedInProstitution === 'yes') req('engagedInProstitutionExplanation')
    if (values.moneyLaundering === 'yes') req('moneyLaunderingExplanation')
    if (values.humanTrafficking === 'yes') req('humanTraffickingExplanation')
    if (values.aidedHumanTrafficking === 'yes') req('aidedHumanTraffickingExplanation')
    if (values.spouseOfTrafficker === 'yes') req('spouseOfTraffickerExplanation')
    if (values.hasSocialSecurityNumber === 'yes') req('socialSecurityNumber')
    if (values.hasTaxpayerID === 'yes') req('taxpayerIDNumber')
    if (values.hasUSDriversLicense === 'yes') {
      const licenses = values.usDriversLicenses || []
      licenses.forEach((lic, i) => {
        if (!lic?.numberDoNotKnow && !String(lic?.number ?? '').trim()) missing.add(`usDriversLicenses.${i}.number`)
        if (!String(lic?.state ?? '').trim()) missing.add(`usDriversLicenses.${i}.state`)
      })
    }
    if (values.passportLostOrStolen === 'yes') {
      const lostPassports = values.lostPassports || []
      lostPassports.forEach((lp, i) => {
        if (!lp?.numberDoNotKnow && !String(lp?.number ?? '').trim()) missing.add(`lostPassports.${i}.number`)
        if (!String(lp?.country ?? '').trim()) missing.add(`lostPassports.${i}.country`)
        if (!String(lp?.explain ?? '').trim()) missing.add(`lostPassports.${i}.explain`)
      })
    }
    req('contactRelationship')
    req('contactStreet')
    req('contactCity')
    req('contactState')
    req('contactPhone')
    if (!values.contactEmailDoesNotApply) req('contactEmail')
    // DS-160 requires a real contact person (both names) or an organization.
    // "Do Not Know" flags describe the unused side; they cannot replace both.
    const hasContactPerson =
      String(values.contactSurnames ?? '').trim() &&
      String(values.contactGivenNames ?? '').trim()
    const hasContactOrganization = String(values.contactOrganization ?? '').trim()
    if (!hasContactPerson && !hasContactOrganization) {
      missing.add('contactSurnames')
      missing.add('contactGivenNames')
      missing.add('contactOrganization')
    }
    if (values.hasCloseRelativesInUS === 'yes') {
      const relatives = values.usRelatives || []
      relatives.forEach((rel, i) => {
        if (!String(rel?.surnames ?? '').trim() && !String(rel?.givenNames ?? '').trim()) missing.add(`usRelatives.${i}.surnames`)
        if (!String(rel?.relationship ?? '').trim()) missing.add(`usRelatives.${i}.relationship`)
        if (!String(rel?.status ?? '').trim()) missing.add(`usRelatives.${i}.status`)
      })
    }
    const employedOccupations = ['AGRICULTURE','ARTIST/PERFORMER','BUSINESS','COMMUNICATIONS','COMPUTER SCIENCE','CULINARY/FOOD SERVICES','EDUCATION','ENGINEERING','GOVERNMENT','LEGAL PROFESSION','MEDICAL/HEALTH','NATURAL SCIENCE','PHYSICAL SCIENCES','RELIGIOUS VOCATION','RESEARCH','SOCIAL SCIENCE','OTHER']
    if (employedOccupations.includes(values.currentOccupation)) {
      req('employerName')
      req('employerStreet')
      req('employerCity')
      req('jobTitle')
      req('employerPhone')
      req('employmentStartDate')
      req('jobDuties')
    }
    if (values.currentOccupation === 'STUDENT') {
      req('studentInstitutionName')
      req('studentDegree')
      req('studentStartDate')
      req('studentInstitutionPhone')
      req('studentInstitutionStreet')
      req('studentInstitutionCity')
    }
    if (values.currentOccupation === 'MILITARY') {
      req('employerName')
      req('jobTitle')
      req('employerCity')
    }
    if (values.workedAnotherJobLast5Years === 'yes') {
      const prevJobs = values.previousEmployments || []
      prevJobs.forEach((job, i) => {
        if (!String(job?.employerName ?? '').trim()) missing.add(`previousEmployments.${i}.employerName`)
        if (!String(job?.jobTitle ?? '').trim()) missing.add(`previousEmployments.${i}.jobTitle`)
        if (!String(job?.dateFrom ?? '').trim()) missing.add(`previousEmployments.${i}.dateFrom`)
        if (!String(job?.dateTo ?? '').trim()) missing.add(`previousEmployments.${i}.dateTo`)
        if (!String(job?.duties ?? '').trim()) missing.add(`previousEmployments.${i}.duties`)
      })
    }
    if (values.hasEducation === 'yes') {
      const edRecords = values.educationRecords || []
      edRecords.forEach((ed, i) => {
        if (!String(ed?.institutionName ?? '').trim()) missing.add(`educationRecords.${i}.institutionName`)
        if (!String(ed?.courseOfStudy ?? '').trim()) missing.add(`educationRecords.${i}.courseOfStudy`)
        if (!String(ed?.dateFrom ?? '').trim()) missing.add(`educationRecords.${i}.dateFrom`)
        if (!String(ed?.dateTo ?? '').trim()) missing.add(`educationRecords.${i}.dateTo`)
      })
    }
    if (values.visitedAbroadLast5Years === 'yes') {
      const countries = values.countriesVisited || []
      if (!countries.some(c => String(c?.country ?? '').trim())) {
        missing.add('countriesVisited.0.country')
      } else {
        countries.forEach((c, i) => {
          if (!String(c?.country ?? '').trim()) missing.add(`countriesVisited.${i}.country`)
        })
      }
    }
    if (values.servedInMilitary === 'yes') {
      const milServices = values.militaryService || []
      milServices.forEach((ms, i) => {
        if (!String(ms?.country ?? '').trim()) missing.add(`militaryService.${i}.country`)
        if (!String(ms?.branch ?? '').trim()) missing.add(`militaryService.${i}.branch`)
      })
    }
    if (values.hasParamilitary === 'yes') req('paramilitaryExplanation')

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
    hasTelecode: watch('hasTelecode'),
    travelingWithOthers: watch('travelingWithOthers'),
    hasForeignCitizenship: watch('hasForeignCitizenship'),
    isPermanentResidentElsewhere: watch('isPermanentResidentElsewhere'),
    foreignNationalities: watch('foreignNationalities'),
    visitedUSBefore: watch('visitedUSBefore'),
    hadUSVisa: watch('hadUSVisa'),
    visaWasCancelled: watch('visaWasCancelled'),
    visaLostOrStolen: watch('visaLostOrStolen'),
    visaNumberDoNotKnow: watch('visaNumberDoNotKnow'),
    refusedOrDeniedUS: watch('refusedOrDeniedUS'),
    immigrantPetition: watch('immigrantPetition'),
    // legacy
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
    hasOtherRelativesInUS: watch('hasOtherRelativesInUS'),
    fatherInUS: watch('fatherInUS'),
    motherInUS: watch('motherInUS'),
    mailingAddressSame: watch('mailingAddressSame'),
    travelingAsGroup: watch('travelingAsGroup'),
    otherPhonesLastFiveYears: watch('otherPhonesLastFiveYears'),
    otherEmailsLastFiveYears: watch('otherEmailsLastFiveYears'),
    hasWebsiteContent: watch('hasWebsiteContent'),
    currentOccupation: watch('currentOccupation'),
    workedAnotherJobLast5Years: watch('workedAnotherJobLast5Years'),
    attendedHighSchool: watch('attendedHighSchool'),
    hasEducation: watch('hasEducation'),
    hasAcademicDegree: watch('hasAcademicDegree'),
    hasClanOrTribe: watch('hasClanOrTribe'),
    visitedAbroadLast5Years: watch('visitedAbroadLast5Years'),
    servedInMilitary: watch('servedInMilitary'),
    hasParamilitary: watch('hasParamilitary'),
    hasSocialMedia: watch('hasSocialMedia'),
    hasOrganizations: watch('hasOrganizations'),
    hasSpecializedSkills: watch('hasSpecializedSkills'),
    maritalStatus: watch('maritalStatus'),
    spouseAddressType: watch('spouseAddressType'),
    spouseBirthCityDoNotKnow: watch('spouseBirthCityDoNotKnow'),
    mondayItemId: watch('mondayItemId'),
    specificTravelPlans: watch('specificTravelPlans'),
    hasExactAccommodationAddress: watch('hasExactAccommodationAddress'),
    accommodationCityPreset: watch('accommodationCityPreset'),
    communicableDisease: watch('communicableDisease'),
    mentalDisorder: watch('mentalDisorder'),
    drugAbuser: watch('drugAbuser'),
    withheldCustody: watch('withheldCustody'),
    votedIllegally: watch('votedIllegally'),
    renouncedCitizenship: watch('renouncedCitizenship'),
    immigrationFraud: watch('immigrationFraud'),
    deportedFromCountry: watch('deportedFromCountry'),
    espionage: watch('espionage'),
    terroristActivities: watch('terroristActivities'),
    supportedTerrorists: watch('supportedTerrorists'),
    terroristMember: watch('terroristMember'),
    spouseOfTerrorist: watch('spouseOfTerrorist'),
    genocide: watch('genocide'),
    torture: watch('torture'),
    extrajudicialKillings: watch('extrajudicialKillings'),
    childSoldiers: watch('childSoldiers'),
    religiousFreedomViolations: watch('religiousFreedomViolations'),
    populationControls: watch('populationControls'),
    organTransplantation: watch('organTransplantation'),
    arrestedOrConvicted: watch('arrestedOrConvicted'),
    violatedControlledSubstances: watch('violatedControlledSubstances'),
    engagedInProstitution: watch('engagedInProstitution'),
    moneyLaundering: watch('moneyLaundering'),
    humanTrafficking: watch('humanTrafficking'),
    aidedHumanTrafficking: watch('aidedHumanTrafficking'),
    spouseOfTrafficker: watch('spouseOfTrafficker'),
    criminalRecord: watch('criminalRecord'),
    selfPaying: watch('selfPaying'),
    tripPayerType: watch('tripPayerType'),
    tripPayerSameAddress: watch('tripPayerSameAddress'),
  }

  const allFormValues = watch()

  function getFieldError(path) {
    if (!path) return undefined
    const rhfErr = errors
      ? path.split('.').reduce((acc, key) => (acc == null ? undefined : /** @type {Record<string, unknown>} */ (acc)[key]), /** @type {unknown} */ (errors))
      : undefined
    if (rhfErr) return rhfErr
    if (translationErrors.has(path)) {
      const currentValue = path.split('.').reduce(
        (acc, key) => (acc == null ? undefined : /** @type {Record<string, unknown>} */ (acc)[key]),
        /** @type {unknown} */ (allFormValues)
      )
      if (currentValue) return undefined
      return { message: 'שדה חובה' }
    }
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

  const contactSurnamesError = getFieldError('contactSurnames')
  const contactGivenNamesError = getFieldError('contactGivenNames')
  const contactOrganizationError = getFieldError('contactOrganization')

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

      {/* ── Floating section navigation ── */}
      <nav
        className="fixed right-3 top-1/2 -translate-y-1/2 z-40 hidden sm:flex flex-col w-[11.5rem] rounded-2xl border border-slate-200/80 bg-white/95 shadow-[0_8px_30px_rgba(15,23,42,0.12)] backdrop-blur-sm overflow-hidden"
        dir="rtl"
        aria-label="ניווט סקשנים"
      >
        <div className="px-3 py-2.5 bg-slate-900 text-white">
          <p className="text-[11px] font-bold tracking-wide uppercase opacity-80">ניווט מהיר</p>
        </div>
        <div className="flex flex-col gap-0.5 p-1.5 max-h-[70vh] overflow-y-auto">
          {[
            { label: 'מידע אישי', id: 'section-personal', emoji: '🪪' },
            { label: 'כתובות', id: 'section-address', emoji: '🏠' },
            { label: 'פרטי קשר', id: 'section-contact', emoji: '📞' },
            { label: 'תכנון נסיעה', id: 'section-travel', emoji: '✈️' },
            { label: 'ביקורים קודמים', id: 'section-prior-visits', emoji: '🇺🇸' },
            { label: 'איש קשר בארה"ב', id: 'section-us-contact', emoji: '🤝' },
            { label: 'משפחה', id: 'section-family', emoji: '👨‍👩‍👧' },
            { label: 'תעסוקה', id: 'section-employment', emoji: '💼' },
            { label: 'השכלה', id: 'section-education', emoji: '🎓' },
            { label: 'ביטחון', id: 'section-security', emoji: '🛡️' },
            { label: 'רשתות חברתיות', id: 'section-social', emoji: '💬' },
            { label: 'ראיון', id: 'section-interview', emoji: '📍' },
          ].map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="group flex items-center gap-2 text-right rounded-lg px-2 py-1.5 transition-all hover:bg-teal-50 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
            >
              <span className="text-base leading-none shrink-0 grayscale-[0.2] group-hover:grayscale-0 group-hover:scale-110 transition-transform" aria-hidden>
                {s.emoji}
              </span>
              <span className="text-[12px] font-bold text-slate-700 group-hover:text-teal-800 truncate leading-snug">
                {s.label}
              </span>
            </button>
          ))}
        </div>
      </nav>

      <div className="max-w-4xl mx-auto bg-white shadow-xl rounded-xl overflow-hidden mt-4">
        <form onSubmit={handleSubmit(onSubmit)} className="p-8 space-y-10">

          <section id="section-personal" className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">שם הלקוח ומידע אישי</h2>
            <div className="space-y-6">

              {/* ── כרטיס 1: דרכון ── */}
              <div className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="font-bold text-lg">פרטי דרכון / מסמך נסיעה</h3>

                {/* OCR slot */}
                <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4">
                  <p className="font-semibold text-gray-800">צילום דרכון</p>
                  <p className="text-xs text-gray-600">
                    גרירה או בחירת קובץ — זיהוי אוטומטי (GPT-4o): שם באנגלית, תאריך לידה, מספר דרכון, מדינת הנפקה, מין (MRZ), תעודת זהות אם מופיעה במסמך.
                  </p>
                  {passportOcr.status === 'loading' && <p className="text-sm text-blue-600">מזהה פרטי דרכון מהקובץ…</p>}
                  {passportOcr.status === 'error' && <p className="text-sm text-red-600" role="alert">{passportOcr.message}</p>}
                  {passportOcr.status === 'idle' && passportOcr.message && <p className="text-sm text-green-700">{passportOcr.message}</p>}
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

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Passport/Travel Document Type */}
                  <FormSelect register={register} getFieldError={getFieldError} label="סוג דרכון / מסמך נסיעה" name="passportType" options={['REGULAR', 'OFFICIAL', 'DIPLOMATIC', 'LAISSEZ-PASSER', 'OTHER']} />

                  {/* Passport/Travel Document Number */}
                  <div id="field-passportId" className="flex flex-col">
                    <label className="font-semibold mb-1 text-gray-700">מספר דרכון / מסמך נסיעה <span className="text-red-500">*</span></label>
                    <input
                      type="text"
                      autoComplete="off"
                      {...register('passportId')}
                      className={`rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 font-mono w-full border ${translationErrors.has('passportId') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                      dir="ltr"
                      placeholder="למשל 201381722"
                    />
                    {translationErrors.has('passportId') && <span className="text-red-500 text-sm mt-1">שדה חובה</span>}
                    <span className="text-xs text-gray-500 mt-1">
                      מזהה טיוטה: <span className="font-mono" dir="ltr">מספר_YYYY-MM-DD</span> — התאריך ({formStartedDateRef.current}) נקבע אוטומטית.
                    </span>
                  </div>

                  {/* Passport Book Number (optional) */}
                  <div className="flex flex-col">
                    <label className="font-semibold mb-1 text-gray-700">מספר ספר דרכון (Passport Book Number)</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        autoComplete="off"
                        {...register('passportBookNumber')}
                        disabled={watch('passportBookNumberDoesNotApply')}
                        className="rounded-md p-2 border border-gray-300 font-mono flex-1 disabled:bg-gray-100 disabled:text-gray-400"
                        dir="ltr"
                      />
                      <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" {...register('passportBookNumberDoesNotApply')} className="rounded" />
                        לא רלוונטי
                      </label>
                    </div>
                  </div>

                  {/* Country/Authority that Issued */}
                  <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="מדינה / רשות שהנפיקה את הדרכון" name="passportIssuingCountry" hint="ממולא אוטומטית מצילום הדרכון" />

                  {/* Where was it issued — sub-section */}
                  <div className="md:col-span-2">
                    <p className="font-semibold text-gray-700 mb-2">היכן הונפק הדרכון? (Where was it issued?)</p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-blue-50 rounded p-3 border border-blue-100">
                      <FormInput register={register} getFieldError={getFieldError} label="עיר (City)" name="passportIssuingCity" hint="לדוגמה: Jerusalem" />
                      <div className="flex flex-col mb-4">
                        <div className="flex items-center justify-between mb-1">
                          <label className="font-semibold text-gray-700">מחוז (Province)<OptionalBadge /></label>
                          <label className="flex items-center gap-1 text-sm text-gray-500 cursor-pointer">
                            <input type="checkbox" {...register('passportIssuingStateNA')} className="rounded"
                              onChange={e => { register('passportIssuingStateNA').onChange(e); if (e.target.checked) setValue('passportIssuingState', '') }} />
                            לא רלוונטי
                          </label>
                        </div>
                        <input
                          type="text"
                          {...register('passportIssuingState')}
                          disabled={watch('passportIssuingStateNA')}
                          className="rounded-md p-2 border border-gray-300 disabled:bg-gray-100 disabled:text-gray-400"
                          placeholder="Province"
                          dir="ltr"
                        />
                      </div>
                      <div className="flex flex-col mb-4">
                        <div className="flex items-center justify-between mb-1">
                          <label className="font-semibold text-gray-700">רשות מנפיקה (Issuing Authority)<OptionalBadge /></label>
                          <label className="flex items-center gap-1 text-sm text-gray-500 cursor-pointer">
                            <input type="checkbox" {...register('passportIssuingAuthorityNA')} className="rounded"
                              onChange={e => { register('passportIssuingAuthorityNA').onChange(e); if (e.target.checked) setValue('passportIssuingAuthority', '') }} />
                            לא רלוונטי
                          </label>
                        </div>
                        <input
                          type="text"
                          {...register('passportIssuingAuthority')}
                          disabled={watch('passportIssuingAuthorityNA')}
                          className="rounded-md p-2 border border-gray-300 disabled:bg-gray-100 disabled:text-gray-400"
                          placeholder="Ministry of Interior"
                          dir="ltr"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Issuance Date */}
                  <DateSelectInput label="תאריך הנפקת דרכון" name="passportIssueDate" hint="ממולא אוטומטית מצילום הדרכון" register={register} getFieldError={getFieldError} translationErrors={translationErrors} setValue={setValue} watch={watch} />

                  {/* Expiration Date + No Expiration checkbox */}
                  <div className="flex flex-col gap-1">
                    <DateSelectInput label="תאריך פקיעת דרכון" name="passportExpirationDate" hint="ממולא אוטומטית מצילום הדרכון" register={register} getFieldError={getFieldError} translationErrors={translationErrors} setValue={setValue} watch={watch} />
                    <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer mt-1">
                      <input type="checkbox" {...register('passportExpirationNoExpiry')} className="rounded" />
                      ללא תפוגה (No Expiration)
                    </label>
                  </div>

                  {/* ── Lost / Stolen Passport ── */}
                  <div className="border-t border-gray-200 pt-4 space-y-3">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אי פעם אבד או נגנב לך דרכון?" name="passportLostOrStolen" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                    {w.passportLostOrStolen === 'yes' && (
                      <div className="space-y-4">
                        {lostPassportFields.map((field, i) => (
                          <div key={field.id} className="bg-white border border-gray-200 rounded p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-gray-700">דרכון אבוד / גנוב #{i + 1}</span>
                              {lostPassportFields.length > 1 && (
                                <button type="button" onClick={() => removeLostPassport(i)} className="text-red-500 text-sm hover:underline">הסר</button>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="font-semibold text-sm text-gray-700">מספר דרכון / מסמך נסיעה <span className="text-red-500">*</span></label>
                              <div className="flex items-center gap-3">
                                <input type="text" {...register(`lostPassports.${i}.number`)}
                                  disabled={watch(`lostPassports.${i}.numberDoNotKnow`)}
                                  className={`rounded-md p-2 border font-mono flex-1 disabled:bg-gray-100 disabled:text-gray-400 ${translationErrors.has(`lostPassports.${i}.number`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                                  dir="ltr" />
                                <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                                  <input type="checkbox" {...register(`lostPassports.${i}.numberDoNotKnow`)} className="rounded" />
                                  לא ידוע
                                </label>
                              </div>
                              {translationErrors.has(`lostPassports.${i}.number`) && <span className="text-red-500 text-xs">שדה חובה</span>}
                            </div>
                            <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="מדינה / רשות שהנפיקה" name={`lostPassports.${i}.country`} />
                            <FormInput register={register} getFieldError={getFieldError} label="הסבר (Explain)" name={`lostPassports.${i}.explain`} type="textarea" />
                          </div>
                        ))}
                        <button type="button"
                          onClick={() => appendLostPassport({ number: '', numberDoNotKnow: false, country: '', explain: '' })}
                          className="text-blue-600 text-sm hover:underline">
                          + הוסף דרכון נוסף
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── כרטיס 2: פרטים אישיים ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">פרטים אישיים</h3>
                <FormInput register={register} getFieldError={getFieldError} label="שם פרטי (עברית)" name="firstName" dir="auto" />
                <FormInput register={register} getFieldError={getFieldError} label="שם משפחה (עברית)" name="lastName" dir="auto" />
                <FormInput register={register} getFieldError={getFieldError} label="שם פרטי באנגלית (מהדרכון)" name="firstNameEnglish" hint="ממולא אוטומטית מצילום הדרכון; לא מחליף את השם בעברית" />
                <FormInput register={register} getFieldError={getFieldError} label="שם משפחה באנגלית (מהדרכון)" name="lastNameEnglish" hint="ממולא אוטומטית מצילום הדרכון; לא מחליף את השם בעברית" />
                <div className="col-span-full mb-0">
                  <div className="-mb-4">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="האם היה לך שם קודם?" name="hadPreviousName" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                  {w.hadPreviousName === 'yes' && (
                    <div className="mt-2 space-y-2">
                      {previousNameFields.map((field, i) => (
                        <div key={field.id} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end pr-2 border-r-2 border-blue-200">
                          <FormInput register={register} getFieldError={getFieldError} label="שם פרטי קודם" name={`previousNames.${i}.given`} />
                          <FormInput register={register} getFieldError={getFieldError} label="שם משפחה קודם" name={`previousNames.${i}.surname`} />
                          {previousNameFields.length > 1 && (
                            <button type="button" onClick={() => removePreviousName(i)} className="pb-1 text-sm text-red-500 hover:text-red-700 font-medium">הסר ✕</button>
                          )}
                        </div>
                      ))}
                      <button type="button" onClick={() => appendPreviousName({ given: '', surname: '' })}
                        className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                        <span aria-hidden className="text-lg leading-none">+</span>
                        הוסף שם קודם
                      </button>
                    </div>
                  )}
                </div>
                <div className="col-span-full mb-0">
                  <div className="-mb-4">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך טלקוד המייצג את שמך?" name="hasTelecode" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                  {w.hasTelecode === 'yes' && (
                    <div className="mt-2 space-y-2">
                      {telecodeFields.map((field, i) => (
                        <div key={field.id} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end pr-2 border-r-2 border-blue-200">
                          <FormInput register={register} getFieldError={getFieldError} label="טלקוד שם פרטי" name={`telecodes.${i}.given`} />
                          <FormInput register={register} getFieldError={getFieldError} label="טלקוד שם משפחה" name={`telecodes.${i}.surname`} />
                          {telecodeFields.length > 1 && (
                            <button type="button" onClick={() => removeTelecode(i)} className="pb-1 text-sm text-red-500 hover:text-red-700 font-medium">הסר ✕</button>
                          )}
                        </div>
                      ))}
                      <button type="button" onClick={() => appendTelecode({ given: '', surname: '' })}
                        className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                        <span aria-hidden className="text-lg leading-none">+</span>
                        הוסף טלקוד
                      </button>
                    </div>
                  )}
                </div>
                <FormRadioGroup register={register} getFieldError={getFieldError} label="מין" name="sex" options={[{ label: 'זכר', value: 'male' }, { label: 'נקבה', value: 'female' }]} />

                <DateSelectInput
                  label="תאריך לידה"
                  nameDay="birthDateDay" nameMonth="birthDateMonth" nameYear="birthDateYear"
                  register={register} getFieldError={getFieldError} translationErrors={translationErrors}
                />
                <FormInput register={register} getFieldError={getFieldError} label="עיר לידה" name="birthCity" />
                <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="מדינת לידה (מהדרכון)" name="birthCountry" hint="ממולא אוטומטית מצילום הדרכון" />
              </div>

              {/* ── כרטיס 2: אזרחות ולאום ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">אזרחות ולאום</h3>

                <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="לאום / אזרחות עיקרית (מהדרכון)" name="nationality" hint="ממולא אוטומטית מצילום הדרכון" />
                <FormInput register={register} getFieldError={getFieldError} label="מספר תעודת זהות" name="idNumber" hint="ממולא אוטומטית מצילום הדרכון אם מופיע" />

                {/* Extra nationality */}
                <div className="col-span-full mb-0">
                  <div className="-mb-4">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך אזרחות נוספת?" name="hasForeignCitizenship" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                  {w.hasForeignCitizenship === 'yes' && (
                    <div className="mt-2 space-y-4">
                      {foreignNationalityFields.map((field, i) => (
                        <div key={field.id} className="pr-3 border-r-2 border-blue-200 space-y-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label={`מדינה ${i + 1}`} name={`foreignNationalities.${i}.country`} />
                          </div>
                          <div className="-mb-2">
                            <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך דרכון זר לאזרחות זו?" name={`foreignNationalities.${i}.hasForeignPassport`} options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                          </div>
                          {watch(`foreignNationalities.${i}.hasForeignPassport`) === 'yes' && (
                            <FormInput register={register} getFieldError={getFieldError} label="מספר זהות / דרכון במדינה זו" name={`foreignNationalities.${i}.id`} optional watch={watch} setValue={setValue} />
                          )}
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1">
                              <DocumentFileSlot
                                label="צילום תעודה (לא חובה)"
                                name={`foreignNationalities.${i}.scan`}
                                register={register}
                                setValue={setValue}
                                getFieldError={getFieldError}
                                watchedValue={w.foreignNationalities?.[i]?.scan}
                                accept="image/*,application/pdf"
                                onFilePicked={(f) => void runForeignPassportOcrFromFile(f, i)}
                              />
                              {foreignPassportOcr[i]?.status === 'loading' && (
                                <p className="text-sm text-blue-600 mt-1">מזהה מספר דרכון מהצילום…</p>
                              )}
                              {foreignPassportOcr[i]?.status === 'error' && (
                                <p className="text-sm text-red-600 mt-1" role="alert">{foreignPassportOcr[i].message}</p>
                              )}
                              {foreignPassportOcr[i]?.status === 'idle' && foreignPassportOcr[i]?.message && (
                                <p className="text-sm text-green-700 mt-1">{foreignPassportOcr[i].message}</p>
                              )}
                            </div>
                            {foreignNationalityFields.length > 1 && (
                              <button type="button" onClick={() => removeForeignNationality(i)} className="mt-1 text-sm text-red-500 hover:text-red-700 font-medium whitespace-nowrap">הסר ✕</button>
                            )}
                          </div>
                        </div>
                      ))}
                      <button type="button" onClick={() => appendForeignNationality({ country: '', hasForeignPassport: 'no', id: '' })}
                        className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                        <span aria-hidden className="text-lg leading-none">+</span>
                        הוסף אזרחות נוספת
                      </button>
                    </div>
                  )}
                </div>

                {/* Permanent residency elsewhere */}
                <div className="col-span-full mb-0">
                  <div className="-mb-4">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אתה תושב קבע במדינה שאינה מדינת לאומך?" name="isPermanentResidentElsewhere" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                  {w.isPermanentResidentElsewhere === 'yes' && (
                    <div className="mt-2 space-y-2">
                      {permanentResidencyFields.map((field, i) => (
                        <div key={field.id} className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end pr-2 border-r-2 border-blue-200">
                          <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label={`מדינת מגורי קבע ${i + 1}`} name={`permanentResidencies.${i}.country`} />
                          {permanentResidencyFields.length > 1 && (
                            <button type="button" onClick={() => removePermanentResidency(i)} className="pb-1 text-sm text-red-500 hover:text-red-700 font-medium">הסר ✕</button>
                          )}
                        </div>
                      ))}
                      <button type="button" onClick={() => appendPermanentResidency({ country: '' })}
                        className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                        <span aria-hidden className="text-lg leading-none">+</span>
                        הוסף מדינה
                      </button>
                    </div>
                  )}
                </div>

                <div className="col-span-full space-y-2">
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך מספר ביטוח לאומי אמריקאי (SSN)?" name="hasSocialSecurityNumber" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  {w.hasSocialSecurityNumber === 'yes' && (
                    <div className="pr-3 border-r-2 border-blue-200">
                      <FormInput register={register} getFieldError={getFieldError} label="מספר SSN" name="usSocialSecurityNumber" hint="לדוגמה: 123-45-6789" />
                    </div>
                  )}
                </div>
                <div className="col-span-full space-y-2">
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך מספר זיהוי משלם מס אמריקאי (ITIN)?" name="hasTaxpayerID" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  {w.hasTaxpayerID === 'yes' && (
                    <div className="pr-3 border-r-2 border-blue-200">
                      <FormInput register={register} getFieldError={getFieldError} label="מספר ITIN" name="usTaxpayerId" hint="לדוגמה: 912-34-5678" />
                    </div>
                  )}
                </div>

                <div className="col-span-full">
                  <FormSelect register={register} getFieldError={getFieldError} label="סטטוס משפחתי" name="maritalStatus" options={['רווק', 'נשוי', 'גרוש', 'אלמן', 'נשוי אזרחית', 'פרוד', 'חיים משותפים']} />
                </div>

                {(w.maritalStatus === 'גרוש' || w.maritalStatus === 'פרוד') && (
                  <div className="col-span-full space-y-4">
                    <h3 className="font-bold text-gray-800 text-base">מידע משפחתי: בן/בת זוג לשעבר</h3>
                    <div className="flex items-center gap-3">
                      <label className="font-semibold text-sm text-gray-700 whitespace-nowrap">מספר בני/בנות זוג לשעבר:</label>
                      <input type="number" min="1" {...register('numberOfFormerSpouses')}
                        className={`rounded-md p-2 border w-20 ${translationErrors.has('numberOfFormerSpouses') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                      {translationErrors.has('numberOfFormerSpouses') && <span className="text-red-500 text-xs">שדה חובה</span>}
                    </div>

                    {formerSpouseFields.map((field, i) => (
                      <div key={field.id} className="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold text-sm text-gray-700">בן/בת זוג לשעבר #{i + 1}</p>
                          {formerSpouseFields.length > 1 && (
                            <button type="button" onClick={() => removeFormerSpouse(i)} className="text-sm text-red-500 hover:underline">הסר</button>
                          )}
                        </div>

                        <FormInput register={register} getFieldError={getFieldError} label="שם משפחה" name={`formerSpouses.${i}.surnames`} />
                        <FormInput register={register} getFieldError={getFieldError} label="שם פרטי" name={`formerSpouses.${i}.givenNames`} />

                        <DateSelectInput label="תאריך לידה" name={`formerSpouses.${i}.birthDate`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />

                        <FormInput register={register} getFieldError={getFieldError} label="אזרחות / לאום" name={`formerSpouses.${i}.nationality`} hint="לדוגמה: ISRAEL" />

                        {/* Place of Birth */}
                        <div className="bg-white rounded border border-gray-200 p-3 space-y-2">
                          <p className="font-semibold text-xs text-gray-600 uppercase tracking-wide">עיר ומדינת לידה</p>
                          <div className="flex flex-col gap-1">
                            <label className="font-semibold text-sm text-gray-700">עיר</label>
                            <div className="flex items-center gap-3">
                              <input type="text" {...register(`formerSpouses.${i}.birthCity`)}
                                disabled={watch(`formerSpouses.${i}.birthCityDoNotKnow`)}
                                className={`rounded-md p-2 border flex-1 disabled:bg-gray-100 disabled:text-gray-400 ${translationErrors.has(`formerSpouses.${i}.birthCity`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                                dir="ltr" />
                              <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                                <input type="checkbox" {...register(`formerSpouses.${i}.birthCityDoNotKnow`)} className="rounded" />
                                לא ידוע
                              </label>
                            </div>
                          </div>
                          <div className="flex flex-col mb-4">
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-semibold text-gray-700">מדינה<OptionalBadge /></span>
                              <label className="flex items-center gap-1 text-sm text-gray-500 cursor-pointer">
                                <input type="checkbox" {...register(`formerSpouses.${i}.birthCountryNA`)} className="rounded"
                                  onChange={e => { register(`formerSpouses.${i}.birthCountryNA`).onChange(e); if (e.target.checked) setValue(`formerSpouses.${i}.birthCountry`, '') }} />
                                לא רלוונטי
                              </label>
                            </div>
                            {!watch(`formerSpouses.${i}.birthCountryNA`) && (
                              <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} name={`formerSpouses.${i}.birthCountry`} />
                            )}
                            {watch(`formerSpouses.${i}.birthCountryNA`) && (
                              <input type="text" disabled className="rounded-md p-2 border border-gray-300 bg-gray-100 text-gray-400" placeholder="לא רלוונטי" />
                            )}
                          </div>
                        </div>

                        <DateSelectInput label="תאריך נישואין" name={`formerSpouses.${i}.marriageDate`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                        <DateSelectInput label="תאריך סיום הנישואין" name={`formerSpouses.${i}.marriageEndDate`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />

                        <div className="flex flex-col gap-1">
                          <label className="font-semibold text-sm text-gray-700">כיצד הסתיימו הנישואין {translationErrors.has(`formerSpouses.${i}.howEnded`) && <span className="text-red-500">*</span>}</label>
                          <textarea {...register(`formerSpouses.${i}.howEnded`)} rows={3}
                            className={`rounded-md p-2 border w-full ${translationErrors.has(`formerSpouses.${i}.howEnded`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                        </div>

                        <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="מדינה שבה הסתיימו הנישואין" name={`formerSpouses.${i}.terminationCountry`} />
                      </div>
                    ))}

                    <button type="button"
                      onClick={() => appendFormerSpouse({ surnames: '', givenNames: '', nationality: '', birthCity: '', birthCityDoNotKnow: false, birthCountry: '', birthCountryNA: true, marriageDate: '', marriageEndDate: '', howEnded: 'Divorce Settlement', terminationCountry: 'Israel' })}
                      className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                      <span aria-hidden className="text-lg leading-none">+</span>
                      הוסף בן/בת זוג לשעבר
                    </button>
                  </div>
                )}

                {w.maritalStatus === 'אלמן' && (
                  <div className="col-span-full border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
                    <h3 className="font-bold text-gray-800 text-base">פרטי בן הזוג שנפטר</h3>
                    <FormInput register={register} getFieldError={getFieldError} label="שם מלא" name="deceasedSpouseName" />
                    <DateSelectInput label="תאריך לידה" name="deceasedSpouseBirthDate" register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                    <FormInput register={register} getFieldError={getFieldError} label="אזרחות" name="deceasedSpouseCitizenship" />
                    <FormInput register={register} getFieldError={getFieldError} label="עיר ומדינת לידה" name="deceasedSpouseBirthCityCountry" />
                  </div>
                )}

                {w.maritalStatus && w.maritalStatus !== 'רווק' && w.maritalStatus !== 'גרוש' && w.maritalStatus !== 'פרוד' && w.maritalStatus !== 'אלמן' && (
                  <div className="col-span-full border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-4">
                    <h3 className="font-bold text-gray-800 text-base">מידע משפחתי: בן/בת זוג נוכחי/ת</h3>
                    <p className="text-xs text-gray-500">הערה: הזן/י מידע על בן/בת הזוג הנוכחי/ת.</p>

                    {/* Spouse's Full Name */}
                    <div className="space-y-3">
                      <p className="font-semibold text-sm text-gray-700">שם מלא של בן/בת הזוג (כולל שם נעורים)</p>
                      <FormInput register={register} getFieldError={getFieldError} label="שם משפחה" name="spouseSurnames" />
                      <FormInput register={register} getFieldError={getFieldError} label="שם פרטי" name="spouseGivenNames" />
                    </div>

                    {/* Date of Birth */}
                    <DateSelectInput
                      label="תאריך לידה"
                      nameDay="spouseBirthDateDay" nameMonth="spouseBirthDateMonth" nameYear="spouseBirthDateYear"
                      register={register} getFieldError={getFieldError}
                    />

                    {/* Nationality */}
                    <FormInput register={register} getFieldError={getFieldError} label="אזרחות / לאום" name="spouseNationality" hint="לדוגמה: ISRAEL" />

                    {/* Place of Birth */}
                    <div className="bg-white rounded border border-gray-200 p-3 space-y-3">
                      <p className="font-semibold text-sm text-gray-700">עיר ומדינת לידה</p>
                      <div className="flex flex-col gap-1">
                        <label className="font-semibold text-sm text-gray-700">עיר</label>
                        <div className="flex items-center gap-3">
                          <input type="text" {...register('spouseBirthCity')} disabled={watch('spouseBirthCityDoNotKnow')}
                            className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                          <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                            <input type="checkbox" {...register('spouseBirthCityDoNotKnow')} className="rounded" />
                            לא ידוע
                          </label>
                        </div>
                      </div>
                      <div className="flex flex-col mb-4">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-gray-700">מדינה<OptionalBadge /></span>
                          <label className="flex items-center gap-1 text-sm text-gray-500 cursor-pointer">
                            <input type="checkbox" {...register('spouseBirthCountryNA')} className="rounded"
                              onChange={e => { register('spouseBirthCountryNA').onChange(e); if (e.target.checked) setValue('spouseBirthCountry', '') }} />
                            לא רלוונטי
                          </label>
                        </div>
                        {!watch('spouseBirthCountryNA') && (
                          <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} name="spouseBirthCountry" />
                        )}
                        {watch('spouseBirthCountryNA') && (
                          <input type="text" disabled className="rounded-md p-2 border border-gray-300 bg-gray-100 text-gray-400" placeholder="לא רלוונטי" />
                        )}
                      </div>
                    </div>

                    {/* Spouse's Address */}
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">כתובת בן/בת הזוג <span className="text-red-500">*</span></label>
                      <select
                        {...register('spouseAddressType')}
                        className={`rounded-md p-2 border w-full ${translationErrors.has('spouseAddressType') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                      >
                        <option value="">- בחר/י -</option>
                        <option value="SAME AS HOME ADDRESS">כתובת הבית</option>
                        <option value="SAME AS MAILING ADDRESS">כתובת הדואר</option>
                        <option value="SAME AS U.S. CONTACT ADDRESS">כתובת איש הקשר בארה״ב</option>
                        <option value="DO NOT KNOW">לא ידוע</option>
                        <option value="OTHER (SPECIFY ADDRESS)">כתובת אחרת (פרט/י)</option>
                      </select>
                      {translationErrors.has('spouseAddressType') && <span className="text-red-500 text-xs">שדה חובה</span>}
                    </div>

                    {/* Other address fields — only when OTHER selected */}
                    {w.spouseAddressType === 'OTHER (SPECIFY ADDRESS)' && (
                      <div className="bg-white rounded border border-gray-200 p-3 space-y-3">
                        <FormInput register={register} getFieldError={getFieldError} label="רחוב (שורה 1)" name="spouseAddressStreet" hint="ללא תיבת דואר" />
                        <FormInput register={register} getFieldError={getFieldError} label="רחוב (שורה 2)" name="spouseAddressStreet2" optional />
                        <FormInput register={register} getFieldError={getFieldError} label="עיר" name="spouseAddressCity" />
                        <div className="flex flex-col gap-1">
                          <label className="font-semibold text-sm text-gray-700">מחוז</label>
                          <div className="flex items-center gap-3">
                            <input type="text" {...register('spouseAddressState')} disabled={watch('spouseAddressStateDoesNotApply')}
                              className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                            <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                              <input type="checkbox" {...register('spouseAddressStateDoesNotApply')} className="rounded" />
                              לא רלוונטי
                            </label>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="font-semibold text-sm text-gray-700">מיקוד</label>
                          <div className="flex items-center gap-3">
                            <input type="text" {...register('spouseAddressZip')} disabled={watch('spouseAddressZipDoesNotApply')}
                              className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                            <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                              <input type="checkbox" {...register('spouseAddressZipDoesNotApply')} className="rounded" />
                              לא רלוונטי
                            </label>
                          </div>
                        </div>
                        <FormInput register={register} getFieldError={getFieldError} label="מדינה" name="spouseAddressCountry" hint="לדוגמה: ISRAEL" />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── כרטיס 3: כתובת מגורים ── */}
              <div id="section-address" className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
                <SectionCopyHeader
                  as="h3"
                  title="כתובת מגורים נוכחית (Home Address)"
                  sectionId="address"
                  setValue={setValue}
                  excludePathname={loadedBlobKeyRef.current}
                  excludeFormId={formUUIDRef.current || storageFormId}
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <FormInput register={register} getFieldError={getFieldError} label="רחוב (Street Address Line 1)" name="addressStreet" hint="לדוגמה: 12 Herzl St" />
                  </div>
                  <div className="md:col-span-2">
                    <FormInput register={register} getFieldError={getFieldError} label="שורת כתובת שנייה (Line 2)" name="addressStreet2" hint="דירה, בניין וכו׳" optional />
                  </div>
                  <FormInput register={register} getFieldError={getFieldError} label="עיר (City)" name="addressCity" />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">מחוז (State/Province)<OptionalBadge /></label>
                    <input
                      {...register('addressState')}
                      placeholder="לדוגמה: Tel Aviv District"
                      dir="ltr"
                      className="w-full rounded-md p-2 border border-gray-300 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">מיקוד (Postal/ZIP Code)<OptionalBadge /></label>
                    <input
                      {...register('addressZip')}
                      placeholder="לדוגמה: 6473214"
                      dir="ltr"
                      className="w-full rounded-md p-2 border border-gray-300 text-sm"
                    />
                  </div>
                  <div>
                    <FormInput register={register} getFieldError={getFieldError} label="מדינה / ארץ (Country/Region)" name="addressCountry" hint="לדוגמה: Israel" />
                  </div>
                </div>

                {/* Mailing Address */}
                <div className="pt-2 border-t border-gray-200">
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="כתובת הדואר זהה לכתובת המגורים?" name="mailingAddressSame" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                  {w.mailingAddressSame === 'no' && (
                    <div className="mt-3 space-y-4 bg-white p-4 rounded border border-gray-200">
                      <h4 className="font-semibold text-gray-700 text-sm">כתובת דואר (Mailing Address)</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                          <FormInput register={register} getFieldError={getFieldError} label="רחוב (Street Address Line 1)" name="mailingStreet" />
                        </div>
                        <div className="md:col-span-2">
                          <FormInput register={register} getFieldError={getFieldError} label="שורת כתובת שנייה (Line 2)" name="mailingStreet2" optional />
                        </div>
                        <FormInput register={register} getFieldError={getFieldError} label="עיר (City)" name="mailingCity" />
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">מחוז (State/Province)<OptionalBadge /></label>
                          <input
                            {...register('mailingState')}
                            placeholder="State / Province"
                            dir="ltr"
                            className="w-full rounded-md p-2 border border-gray-300 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">מיקוד (Postal/ZIP Code)<OptionalBadge /></label>
                          <input
                            {...register('mailingZip')}
                            placeholder="ZIP / Postal Code"
                            dir="ltr"
                            className="w-full rounded-md p-2 border border-gray-300 text-sm"
                          />
                        </div>
                        <FormInput register={register} getFieldError={getFieldError} label="מדינה / ארץ (Country/Region)" name="mailingCountry" hint="לדוגמה: Israel" />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── כרטיס 4: טלפון ואימייל ── */}
              <div id="section-contact" className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
                <SectionCopyHeader
                  as="h3"
                  title="טלפון ואימייל"
                  sectionId="contact"
                  setValue={setValue}
                  excludePathname={loadedBlobKeyRef.current}
                  excludeFormId={formUUIDRef.current || storageFormId}
                />

                {/* Primary Phone */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">טלפון ראשי (Primary Phone Number)</label>
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

                {/* Secondary Phone */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">טלפון משני (Secondary Phone Number)<OptionalBadge /></label>
                  <input
                    type="tel"
                    {...register('secondaryPhone')}
                    placeholder="לדוגמה: 0523344505"
                    dir="ltr"
                    className="w-full rounded-md p-2 border border-gray-300 text-sm"
                  />
                </div>

                {/* Work Phone */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">טלפון עבודה (Work Phone Number)<OptionalBadge /></label>
                  <input
                    type="tel"
                    {...register('workPhone')}
                    placeholder="לדוגמה: 0523344505"
                    dir="ltr"
                    className="w-full rounded-md p-2 border border-gray-300 text-sm"
                  />
                </div>

                {/* Other Phones (5 years) */}
                <div>
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם השתמשת במספרי טלפון אחרים ב-5 השנים האחרונות?" name="otherPhonesLastFiveYears" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} optional />
                  {w.otherPhonesLastFiveYears === 'yes' && (
                    <div className="mt-2 space-y-2 border-r-2 border-blue-200 pr-3">
                      {otherPhoneFields.map((field, index) => (
                        <div key={field.id} className="flex gap-2 items-center">
                          <input
                            {...register(`otherPhones.${index}.number`)}
                            placeholder="מספר טלפון"
                            dir="ltr"
                            className="flex-1 rounded-md p-2 border border-gray-300 text-sm"
                          />
                          {otherPhoneFields.length > 1 && (
                            <button type="button" onClick={() => removeOtherPhone(index)} className="text-sm text-red-500 hover:text-red-700">הסר ✕</button>
                          )}
                        </div>
                      ))}
                      <button type="button" onClick={() => appendOtherPhone({ number: '' })} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ הוסף מספר</button>
                    </div>
                  )}
                </div>

                {/* Email */}
                <FormInput register={register} getFieldError={getFieldError} label="כתובת אימייל (Email Address)" name="email" type="email" />

                {/* Other Emails (5 years) */}
                <div>
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם השתמשת בכתובות אימייל אחרות ב-5 השנים האחרונות?" name="otherEmailsLastFiveYears" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} optional />
                  {w.otherEmailsLastFiveYears === 'yes' && (
                    <div className="mt-2 space-y-2 border-r-2 border-blue-200 pr-3">
                      {otherEmailFields.map((field, index) => (
                        <div key={field.id} className="flex gap-2 items-center">
                          <input
                            {...register(`otherEmails.${index}.address`)}
                            placeholder="כתובת אימייל"
                            dir="ltr"
                            type="email"
                            className="flex-1 rounded-md p-2 border border-gray-300 text-sm"
                          />
                          {otherEmailFields.length > 1 && (
                            <button type="button" onClick={() => removeOtherEmail(index)} className="text-sm text-red-500 hover:text-red-700">הסר ✕</button>
                          )}
                        </div>
                      ))}
                      <button type="button" onClick={() => appendOtherEmail({ address: '' })} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ הוסף אימייל</button>
                    </div>
                  )}
                </div>
              </div>

            </div>
          </section>

          <section id="section-travel" className="space-y-4">
            <SectionCopyHeader
              title={<>תכנון נסיעה לארה&quot;ב</>}
              sectionId="travel"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
            />
            <div className="grid grid-cols-1 gap-4">
              <FormSelect register={register} getFieldError={getFieldError} label="מטרת הנסיעה / סוג הויזה" name="visaClass" options={['B1/B2 — תיירות ועסקים', 'F1/M1 — ויזת סטודנט']} />

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש לך תוכניות נסיעה ספציפיות?" name="specificTravelPlans" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />

              {/* ── YES: specific plans ── */}
              {w.specificTravelPlans === 'yes' && (
                <div className="space-y-4 pr-3 border-r-2 border-blue-200">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <DateSelectInput label="תאריך הגעה לארה״ב" name="plannedArrivalDate" register={register} getFieldError={getFieldError} translationErrors={translationErrors} setValue={setValue} watch={watch} />
                    <FormInput register={register} getFieldError={getFieldError} label="טיסת הגעה (אם ידוע)" name="arrivalFlight" hint="לדוגמה: LY007" optional naGate watch={watch} setValue={setValue} />
                    <FormInput register={register} getFieldError={getFieldError} label="עיר הגעה בארה״ב" name="arrivalCity" hint="לדוגמה: New York" />
                    <DateSelectInput label="תאריך עזיבה מארה״ב" name="departureDateUS" register={register} getFieldError={getFieldError} translationErrors={translationErrors} setValue={setValue} watch={watch} />
                    <FormInput register={register} getFieldError={getFieldError} label="טיסת יציאה (אם ידוע)" name="departureFlight" hint="לדוגמה: LY008" optional naGate watch={watch} setValue={setValue} />
                    <FormInput register={register} getFieldError={getFieldError} label="עיר יציאה מארה״ב" name="departureCity" hint="לדוגמה: New York" />
                  </div>

                  {/* Locations to visit — repeated */}
                  <div>
                    <p className="font-semibold text-gray-700 mb-2">מקומות לביקור בארה״ב</p>
                    <div className="space-y-2">
                      {locationFields.map((field, i) => (
                        <div key={field.id} className="flex gap-2 items-center">
                          <div className="flex-1">
                            <FormInput register={register} getFieldError={getFieldError} label={`מיקום ${i + 1}`} name={`locationsToVisit.${i}.location`} hint="לדוגמה: Miami, FL" />
                          </div>
                          {locationFields.length > 1 && (
                            <button type="button" onClick={() => removeLocation(i)} className="mt-6 text-sm text-red-500 hover:text-red-700 font-medium whitespace-nowrap">הסר ✕</button>
                          )}
                        </div>
                      ))}
                    </div>
                    <button type="button" onClick={() => appendLocation({ location: '' })}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                      <span aria-hidden className="text-lg leading-none">+</span>
                      הוסף מיקום
                    </button>
                  </div>

                  {/* Accommodation address */}
                  <AccommodationBlock
                    register={register} watch={watch} setValue={setValue}
                    getFieldError={getFieldError} translationErrors={translationErrors}
                    hasExact={w.hasExactAccommodationAddress}
                    cityPreset={w.accommodationCityPreset}
                    excludePathname={loadedBlobKeyRef.current}
                    excludeFormId={formUUIDRef.current || storageFormId}
                  />
                </div>
              )}

              {/* ── NO: no specific plans ── */}
              {w.specificTravelPlans === 'no' && (
                <div className="space-y-4 pr-3 border-r-2 border-blue-200">
                  <DateSelectInput label="תאריך הגעה משוערת לארה״ב" name="plannedArrivalDate" register={register} getFieldError={getFieldError} translationErrors={translationErrors} setValue={setValue} watch={watch} />
                  <div>
                    <label className="font-semibold text-gray-700 mb-1 block">משך השהייה המתוכננת</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="number"
                        min="1"
                        {...register('plannedStayValue')}
                        className={`rounded-md p-2 border w-24 ${translationErrors.has('plannedStayValue') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                        placeholder="מספר"
                      />
                      <select
                        {...register('plannedStayUnit')}
                        className={`rounded-md p-2 border ${translationErrors.has('plannedStayUnit') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                      >
                        <option value="">— בחר יחידה —</option>
                        <option value="YEAR(S)">שנים</option>
                        <option value="MONTH(S)">חודשים</option>
                        <option value="WEEK(S)">שבועות</option>
                        <option value="DAY(S)">ימים</option>
                        <option value="LESS THAN 24 HOURS">פחות מ-24 שעות</option>
                      </select>
                    </div>
                    {(translationErrors.has('plannedStayValue') || translationErrors.has('plannedStayUnit')) && (
                      <span className="text-red-500 text-sm mt-1 block">שדה חובה</span>
                    )}
                  </div>

                  {/* Accommodation address — required even without specific plans */}
                  <AccommodationBlock
                    register={register} watch={watch} setValue={setValue}
                    getFieldError={getFieldError} translationErrors={translationErrors}
                    hasExact={w.hasExactAccommodationAddress}
                    cityPreset={w.accommodationCityPreset}
                    excludePathname={loadedBlobKeyRef.current}
                    excludeFormId={formUUIDRef.current || storageFormId}
                  />
                </div>
              )}

              {/* ── Person/Entity Paying ── */}
              <div className="space-y-3">
                <label className="font-semibold text-gray-700 block">מי משלם את הנסיעה?</label>
                <select
                  {...register('tripPayerType')}
                  className={`rounded-md p-2 border w-full max-w-xs ${translationErrors.has('tripPayerType') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                >
                  <option value="SELF">עצמי (SELF)</option>
                  <option value="OTHER_PERSON">אדם אחר (OTHER PERSON)</option>
                  <option value="PRESENT_EMPLOYER">מעסיק נוכחי (PRESENT EMPLOYER)</option>
                  <option value="EMPLOYER_IN_US">מעסיק בארה״ב (EMPLOYER IN THE U.S.)</option>
                  <option value="OTHER_COMPANY_ORGANIZATION">חברה / ארגון אחר (OTHER COMPANY/ORGANIZATION)</option>
                </select>

                {w.tripPayerType === 'OTHER_PERSON' && (
                  <div className="border border-blue-200 rounded-lg p-4 bg-blue-50 space-y-3">
                    <p className="text-sm font-semibold text-blue-700">פרטי המשלם</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <FormInput register={register} getFieldError={getFieldError} label="שם משפחה" name="tripPayerSurname" />
                      <FormInput register={register} getFieldError={getFieldError} label="שם פרטי" name="tripPayerGivenName" />
                      <FormInput register={register} getFieldError={getFieldError} label="מספר טלפון" name="tripPayerPhone" type="tel" />
                      <FormInput register={register} getFieldError={getFieldError} label="דואר אלקטרוני" name="tripPayerEmail" type="email" optional naGate watch={watch} setValue={setValue} />
                      <div className="flex flex-col gap-1">
                        <label className="font-semibold text-sm text-gray-700">קרבה למבקש</label>
                        <select {...register('tripPayerRelationship')} className="rounded-md p-2 border border-gray-300 bg-white">
                          <option value="">בחר...</option>
                          <option value="CHILD">ילד/ה</option>
                          <option value="PARENT">הורה</option>
                          <option value="SPOUSE">בן/בת זוג</option>
                          <option value="OTHER RELATIVE">קרוב משפחה אחר</option>
                          <option value="FRIEND">חבר/ה</option>
                          <option value="OTHER">אחר</option>
                        </select>
                      </div>
                    </div>
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="האם כתובת המשלם זהה לכתובת הבית / הדואר שלי?" name="tripPayerSameAddress" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                    {w.tripPayerSameAddress === 'no' && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                        <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב (שורה 1)" name="tripPayerAddressStreet1" />
                        <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב (שורה 2)" name="tripPayerAddressStreet2" optional />
                        <FormInput register={register} getFieldError={getFieldError} label="עיר" name="tripPayerAddressCity" />
                        <FormInput register={register} getFieldError={getFieldError} label="מדינה / פרובינציה" name="tripPayerAddressState" optional naGate watch={watch} setValue={setValue} />
                        <FormInput register={register} getFieldError={getFieldError} label="מיקוד" name="tripPayerAddressZip" optional naGate watch={watch} setValue={setValue} />
                        <FormInput register={register} getFieldError={getFieldError} label="מדינה (ארץ)" name="tripPayerAddressCountry" hint="לדוגמה: Israel" />
                      </div>
                    )}
                  </div>
                )}

                {w.tripPayerType === 'OTHER_COMPANY_ORGANIZATION' && (
                  <div className="border border-blue-200 rounded-lg p-4 bg-blue-50 space-y-3">
                    <p className="text-sm font-semibold text-blue-700">פרטי החברה / הארגון המממן</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <FormInput register={register} getFieldError={getFieldError} label="שם החברה / הארגון" name="tripPayerOrgName" />
                      <FormInput register={register} getFieldError={getFieldError} label="מספר טלפון" name="tripPayerPhone" type="tel" />
                      <FormInput register={register} getFieldError={getFieldError} label="קרבה / זיקה למבקש" name="tripPayerOrgRelationship" />
                    </div>
                    <p className="text-sm font-semibold text-gray-700 mt-2">כתובת החברה / הארגון</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב (שורה 1)" name="tripPayerAddressStreet1" />
                      <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב (שורה 2)" name="tripPayerAddressStreet2" optional />
                      <FormInput register={register} getFieldError={getFieldError} label="עיר" name="tripPayerAddressCity" />
                      <FormInput register={register} getFieldError={getFieldError} label="מדינה / פרובינציה" name="tripPayerAddressState" optional naGate watch={watch} setValue={setValue} />
                      <FormInput register={register} getFieldError={getFieldError} label="מיקוד" name="tripPayerAddressZip" optional naGate watch={watch} setValue={setValue} />
                      <FormInput register={register} getFieldError={getFieldError} label="מדינה (ארץ)" name="tripPayerAddressCountry" hint="לדוגמה: Israel" />
                    </div>
                  </div>
                )}
              </div>

              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם יש אנשים נוספים הנוסעים איתך?" name="travelingWithOthers" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              {w.travelingWithOthers === 'yes' && (
                <div className="pr-3 border-r-2 border-blue-200 space-y-4">
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אתה נוסע כחלק מקבוצה או ארגון?" name="travelingAsGroup" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />

                  {w.travelingAsGroup === 'yes' && (
                    <FormInput register={register} getFieldError={getFieldError} label="שם הקבוצה / הארגון" name="travelGroupName" hint="לדוגמה: Israel Tourism Group" />
                  )}

                  {w.travelingAsGroup === 'no' && (
                    <div className="space-y-3">
                      {travelCompanionFields.map((field, index) => (
                        <div
                          key={field.id}
                          className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end border-b border-gray-200 pb-3 last:border-b-0 last:pb-0"
                        >
                          <FormInput register={register} getFieldError={getFieldError} label="שם משפחה" name={`travelCompanions.${index}.surname`} />
                          <FormInput register={register} getFieldError={getFieldError} label="שם פרטי" name={`travelCompanions.${index}.givenName`} />
                          <div className="flex flex-col gap-1">
                            <label className="font-semibold text-sm text-gray-700">קרבה</label>
                            <select
                              {...register(`travelCompanions.${index}.relationship`)}
                              className={`rounded-md p-2 border bg-white ${getFieldError(`travelCompanions.${index}.relationship`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                            >
                              <option value="">בחר...</option>
                              <option value="PARENT">הורה</option>
                              <option value="SPOUSE">בן/בת זוג</option>
                              <option value="CHILD">ילד/ה</option>
                              <option value="OTHER RELATIVE">קרוב משפחה אחר</option>
                              <option value="FRIEND">חבר/ה</option>
                              <option value="BUSINESS ASSOCIATE">שותף עסקי</option>
                              <option value="OTHER">אחר</option>
                            </select>
                            {getFieldError(`travelCompanions.${index}.relationship`) && (
                              <span className="text-red-500 text-xs">שדה חובה</span>
                            )}
                          </div>
                          {travelCompanionFields.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeTravelCompanion(index)}
                              className="pb-1 text-sm text-red-500 hover:text-red-700 font-medium"
                            >
                              הסר ✕
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => appendTravelCompanion({ surname: '', givenName: '', relationship: '' })}
                        className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                      >
                        <span aria-hidden className="text-lg leading-none">+</span>
                        הוסף נוסע
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          <section id="section-prior-visits" className="space-y-4">
            <SectionCopyHeader
              title={<>ביקורים קודמים בארה&quot;ב</>}
              sectionId="priorVisits"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
            />
            <div className="grid grid-cols-1 gap-4">

              {/* ── 1. Visited the US before? ── */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אי פעם ביקרת בארה״ב?" name="visitedUSBefore" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                </div>
                {/* I-94 lookup — always visible when feature is enabled */}
                {i94Enabled && (
                  <div className="flex items-center gap-2 shrink-0">
                    {i94State.status === 'loading' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600 border border-blue-200 animate-pulse">
                        <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                        I-94…
                      </span>
                    )}
                    {i94State.status === 'idle' && i94State.data?.success && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200" title="I-94 נטען בהצלחה">
                        ✓ I-94
                      </span>
                    )}
                    {i94State.status === 'error' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600 border border-red-200" title={i94State.error}>
                        ✗ I-94
                        {i94State.error?.includes('local') || i94State.error?.includes('LOCAL') ? ' (local only)' : ''}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={i94State.status === 'loading' || !canRunI94}
                      onClick={() => { i94AutoRanRef.current = true; void handleI94Lookup() }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-slate-800 text-white hover:bg-slate-900 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                      title={canRunI94 ? 'שלוף היסטוריית כניסות מ-I-94' : 'נדרש: שם, תאריך לידה, מספר דרכון ומדינת הנפקה'}
                    >
                      🔍 בדוק I-94
                    </button>
                  </div>
                )}
              </div>
              {w.visitedUSBefore === 'yes' && (
                <div className="space-y-3 rounded-lg border-r-4 border-blue-500 bg-gray-50 p-4">
                  <div className="flex items-center justify-between">
                    <label className="font-semibold text-gray-700">ביקורים קודמים (עד 5 אחרונים) — תאריך הגעה + אורך שהייה</label>
                    <button
                      type="button"
                      onClick={() => appendPreviousVisit({ arrivalDate: '', stayValue: '', stayUnit: '' })}
                      className="inline-flex items-center gap-1 rounded-md border border-blue-600 bg-white px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                    >
                      + הוסף ביקור
                    </button>
                  </div>
                  {translationErrors.has('previousUSVisits') && (
                    <span className="text-red-500 text-sm">נדרש לפחות ביקור אחד</span>
                  )}
                  <div className="space-y-3">
                    {previousVisitFields.map((field, index) => (
                      <div key={field.id} className="grid grid-cols-1 sm:grid-cols-[1fr_100px_130px_auto] gap-2 items-end bg-white border border-gray-200 rounded-lg p-3">
                        <DateSelectInput
                          label="תאריך הגעה"
                          name={`previousUSVisits.${index}.arrivalDate`}
                          register={register} getFieldError={getFieldError} translationErrors={translationErrors}
                          setValue={setValue} watch={watch}
                          className="flex flex-col"
                        />
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">כמות</label>
                          <input
                            {...register(`previousUSVisits.${index}.stayValue`)}
                            placeholder="מספר"
                            dir="ltr"
                            className={`w-full rounded-md p-2 border text-sm ${getFieldError(`previousUSVisits.${index}.stayValue`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                          />
                          {getFieldError(`previousUSVisits.${index}.stayValue`) && (
                            <span className="text-red-500 text-xs mt-0.5 block">שדה חובה</span>
                          )}
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">יחידה</label>
                          <select
                            {...register(`previousUSVisits.${index}.stayUnit`)}
                            className={`w-full rounded-md p-2 border text-sm bg-white ${getFieldError(`previousUSVisits.${index}.stayUnit`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                            dir="ltr"
                          >
                            <option value="">-- יחידה --</option>
                            <option value="DAYS">ימים</option>
                            <option value="WEEKS">שבועות</option>
                            <option value="MONTHS">חודשים</option>
                            <option value="YEARS">שנים</option>
                          </select>
                          {getFieldError(`previousUSVisits.${index}.stayUnit`) && (
                            <span className="text-red-500 text-xs mt-0.5 block">שדה חובה</span>
                          )}
                        </div>
                        {previousVisitFields.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removePreviousVisit(index)}
                            className="pb-1 text-sm text-red-500 hover:text-red-700 font-medium"
                          >
                            הסר ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                    <input type="checkbox" {...register('hasESTAPermit')} className="rounded" />
                    ללקוח יש / היה אישור ESTA (היתר נסיעה אלקטרוני לארה״ב)
                  </label>
                </div>
              )}

              {i94Enabled && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/90 p-4 space-y-3">
                  <h3 className="text-lg font-bold text-gray-800">היסטוריית כניסות (I-94)</h3>
                  {!canRunI94 && (
                    <p className="text-sm text-gray-500">
                      כדי להפעיל בדיקת I-94: מלא שם (אנגלי או עברי), תאריך לידה מלא, מספר דרכון ומדינת הנפקה באנגלית.
                    </p>
                  )}
                  {canRunI94 && (
                    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold text-gray-800">בדיקת I-94</p>
                        <button
                          type="button"
                          disabled={i94State.status === 'loading' || asyncFlow.phase === 'working' || i94SkipBecausePriorVisits}
                          onClick={() => void handleI94Lookup()}
                          className="px-4 py-2 text-sm font-semibold rounded-md bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40"
                        >
                          {i94State.status === 'loading' ? 'טוען…' : 'בדוק היסטוריית כניסות'}
                        </button>
                      </div>
                      {i94SkipBecausePriorVisits && (
                        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                          שדה ביקורים קודמים כבר מלא — לא תורץ בדיקת I-94 (חיסכון בעלות). רוקנו את השדה כדי להפעיל.
                        </p>
                      )}
                      <p className="text-xs text-gray-600">
                        נדרשים שם, תאריך לידה מלא, מספר דרכון ומדינת הנפקה באנגלית. הפעולה רצה בענן (Browser Use).
                      </p>
                      {i94State.error && <p className="text-sm text-red-600" role="alert">{i94State.error}</p>}
                      {i94State.data && (
                        <div className="overflow-x-auto">
                          {!i94State.data.success && <p className="text-sm text-amber-800">לא הוחזרה היסטוריה (success=false).</p>}
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
                                    <td className="p-2 font-mono" dir="ltr">{row.date}</td>
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
                </div>
              )}

              {/* ── 2. US Driver's License ── */}
              <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
                <div className="flex flex-col xl:flex-row gap-4 xl:items-start xl:gap-6">
                  <div className="shrink-0 xl:min-w-[260px]">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="היה לך רישיון נהיגה אמריקאי?" name="hasUSDriversLicense" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                  {w.hasUSDriversLicense === 'yes' && (
                    <div className="flex-1 min-w-0 space-y-4 rounded-lg border-r-4 border-blue-500 bg-gray-50 p-4">
                      <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
                        <p className="text-xs text-gray-600">
                          העלאת צילום — זיהוי אוטומטי (GPT-4o): מספר רישיון ומדינת/מחוז ארה״ב (State, באנגלית).
                        </p>
                        {usLicenseOcr.status === 'loading' && <p className="text-sm text-blue-600">מזהה פרטי רישיון מהקובץ…</p>}
                        {usLicenseOcr.status === 'error' && <p className="text-sm text-red-600" role="alert">{usLicenseOcr.message}</p>}
                        {usLicenseOcr.status === 'idle' && usLicenseOcr.message && <p className="text-sm text-green-700">{usLicenseOcr.message}</p>}
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
                      <div className="space-y-3">
                        {usDriversLicenseFields.map((field, index) => (
                          <div key={field.id} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end bg-white border border-gray-200 rounded-lg p-3">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">מספר רישיון</label>
                              <input
                                {...register(`usDriversLicenses.${index}.number`)}
                                placeholder="License Number"
                                dir="ltr"
                                disabled={!!watch(`usDriversLicenses.${index}.numberDoNotKnow`)}
                                className={`w-full rounded-md p-2 border text-sm ${translationErrors.has(`usDriversLicenses.${index}.number`) ? 'border-red-400 bg-red-50' : 'border-gray-300'} disabled:bg-gray-100 disabled:text-gray-400`}
                              />
                              <label className="inline-flex items-center gap-1.5 mt-1 text-xs text-gray-600 cursor-pointer">
                                <input type="checkbox" {...register(`usDriversLicenses.${index}.numberDoNotKnow`)} className="rounded" />
                                Does Not Know
                              </label>
                              {translationErrors.has(`usDriversLicenses.${index}.number`) && (
                                <span className="text-red-500 text-xs block">שדה חובה</span>
                              )}
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">מדינה (State)</label>
                              <input
                                {...register(`usDriversLicenses.${index}.state`)}
                                placeholder="e.g. CA, NY"
                                dir="ltr"
                                className={`w-full rounded-md p-2 border text-sm ${translationErrors.has(`usDriversLicenses.${index}.state`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                              />
                              {translationErrors.has(`usDriversLicenses.${index}.state`) && (
                                <span className="text-red-500 text-xs block">שדה חובה</span>
                              )}
                            </div>
                            {usDriversLicenseFields.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeUSDriversLicense(index)}
                                className="pb-1 text-sm text-red-500 hover:text-red-700 font-medium"
                              >
                                הסר ✕
                              </button>
                            )}
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => appendUSDriversLicense({ number: '', numberDoNotKnow: false, state: '' })}
                          className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                        >
                          <span aria-hidden className="text-lg leading-none">+</span>
                          הוסף רישיון
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── 3. Previous US Visa ── */}
              <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
                <div className="flex flex-col xl:flex-row gap-4 xl:items-start xl:gap-6">
                  <div className="shrink-0 xl:min-w-[280px]">
                    <FormRadioGroup register={register} getFieldError={getFieldError} label="הייתה לך בעבר ויזה לארה״ב?" name="hadUSVisa" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                  </div>
                  {w.hadUSVisa === 'yes' && (
                    <div className="flex-1 min-w-0 space-y-4 rounded-lg border-r-4 border-blue-500 bg-gray-50 p-4">
                      <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
                        <p className="text-xs text-gray-600">
                          העלאת צילום ויזה — זיהוי אוטומטי (GPT-4o): תאריך הנפקה ותאריך תפוגה (YYYY-MM-DD כשאפשר), בלי ניחוש.
                        </p>
                        {previousVisaOcr.status === 'loading' && <p className="text-sm text-blue-600">מזהה תאריכים מהקובץ…</p>}
                        {previousVisaOcr.status === 'error' && <p className="text-sm text-red-600" role="alert">{previousVisaOcr.message}</p>}
                        {previousVisaOcr.status === 'idle' && previousVisaOcr.message && <p className="text-sm text-green-700">{previousVisaOcr.message}</p>}
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
                      <div>
                        <FormInput
                          register={register}
                          getFieldError={getFieldError}
                          label="מספר הויזה"
                          name="visaNumber"
                          hint="מספר אדום על מדבקת הויזה, לדוגמה: Y0000000000"
                          disabled={!!w.visaNumberDoNotKnow}
                        />
                        <label className="inline-flex items-center gap-1.5 mt-1 text-xs text-gray-600 cursor-pointer">
                          <input type="checkbox" {...register('visaNumberDoNotKnow')} className="rounded" />
                          Does Not Know
                        </label>
                      </div>
                      <DateSelectInput label="תאריך הנפקת הויזה האחרונה" name="lastVisaIssueDate" hint="ניתן למלא אוטומטית מצילום הויזה" register={register} getFieldError={getFieldError} translationErrors={translationErrors} setValue={setValue} watch={watch} />
                      <FormRadioGroup register={register} getFieldError={getFieldError} label="האם מבקש/ת אותו סוג ויזה כמו הפעם הקודמת?" name="sameVisaType" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                      <FormRadioGroup register={register} getFieldError={getFieldError} label="האם הויזה הקודמת שלך הונפקה בישראל?" name="visaIssuedInIsrael" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
                      <FormRadioGroup register={register} getFieldError={getFieldError} label="האם עברת טביעות אצבעות של 10 אצבעות (ten-print) בארה״ב?" name="tenPrinted" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                      <div>
                        <FormRadioGroup register={register} getFieldError={getFieldError} label="האם הויזה שלך בוטלה או נשללה?" name="visaWasCancelled" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                        {w.visaWasCancelled === 'yes' && (
                          <div className="mt-2">
                            <FormInput register={register} getFieldError={getFieldError} label="הסבר לביטול/שלילת הויזה" name="visaWasCancelledExplanation" type="textarea" />
                          </div>
                        )}
                      </div>
                      <div>
                        <FormRadioGroup register={register} getFieldError={getFieldError} label="האם הויזה שלך לארה״ב אי פעם אבדה או נגנבה?" name="visaLostOrStolen" options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                        {w.visaLostOrStolen === 'yes' && (
                          <div className="mt-2 space-y-3 rounded-lg border-r-4 border-amber-400 bg-amber-50 p-3">
                            <FormInput register={register} getFieldError={getFieldError} label="שנת האובדן / גניבה" name="visaLostOrStolenYear" hint="לדוגמה: 2018" />
                            <FormInput register={register} getFieldError={getFieldError} label="הסבר על האובדן / גניבה" name="visaLostOrStolenExplanation" type="textarea" />
                          </div>
                        )}
                      </div>
                      <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                        <input type="checkbox" {...register('visaNoCopyAvailable')} className="rounded" />
                        אין ברשות הלקוח עותק של הויזה הקודמת
                      </label>
                    </div>
                  )}
                </div>
              </div>

              {/* ── 4. Refused / Denied ── */}
              <div>
                <FormRadioGroup
                  register={register}
                  getFieldError={getFieldError}
                  label="האם אי פעם נדחית לויזה לארה״ב, נסרבת כניסה, הפרת תנאי שהייה, או נסוגה מבקשה?"
                  name="refusedOrDeniedUS"
                  options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]}
                />
                {w.refusedOrDeniedUS === 'yes' && (
                  <div className="mt-2 rounded-lg border-r-4 border-red-400 bg-red-50 p-3">
                    <FormInput register={register} getFieldError={getFieldError} label="הסבר — מתי, איפה, ומדוע" name="refusedOrDeniedExplanation" type="textarea" />
                  </div>
                )}
              </div>

              {/* ── 5. Immigrant petition ── */}
              <div>
                <FormRadioGroup
                  register={register}
                  getFieldError={getFieldError}
                  label="האם הוגשה בעבר בקשת הגירה (immigrant petition) עבורך?"
                  name="immigrantPetition"
                  options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]}
                />
                {w.immigrantPetition === 'yes' && (
                  <div className="mt-2 rounded-lg border-r-4 border-blue-400 bg-blue-50 p-3">
                    <FormInput register={register} getFieldError={getFieldError} label="הסבר — מי הגיש, מתי, ומה הסטטוס" name="immigrantPetitionExplanation" type="textarea" />
                  </div>
                )}
              </div>

            </div>
          </section>

          <section id="section-us-contact" className="space-y-4">
            <SectionCopyHeader
              title={<>איש קשר בארה&quot;ב (U.S. Point of Contact)</>}
              sectionId="usContact"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
            />
            <input type="hidden" {...register('hasUSContact')} value="yes" />
            <p className="text-sm text-gray-600">
              חובה להזין פרטים מלאים של איש קשר או שם ארגון בארה״ב, וכן כתובת ומספר טלפון.
            </p>
            <div className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">

                {/* Contact Person */}
                <div id="field-contactSurnames" className={`bg-white rounded border p-4 space-y-3 ${contactSurnamesError || contactGivenNamesError ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}>
                  <p className="font-semibold text-gray-800">Contact Person <span className="text-gray-400 font-normal text-sm">(נדרש אחד מבין Contact Person / Organization)</span></p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">שם משפחה (Surnames)</label>
                      <input
                        type="text"
                        {...register('contactSurnames')}
                        disabled={watch('contactNameDoNotKnow')}
                        className="rounded-md p-2 border border-gray-300 w-full disabled:bg-gray-100 disabled:text-gray-400"
                        dir="ltr"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">שם פרטי (Given Names)</label>
                      <input
                        type="text"
                        {...register('contactGivenNames')}
                        disabled={watch('contactNameDoNotKnow')}
                        className="rounded-md p-2 border border-gray-300 w-full disabled:bg-gray-100 disabled:text-gray-400"
                        dir="ltr"
                      />
                    </div>
                  </div>
                  {(contactSurnamesError || contactGivenNamesError) && (
                    <span className="text-red-500 text-xs">יש להזין שם משפחה ושם פרטי, או להזין שם ארגון</span>
                  )}
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                    <input type="checkbox" {...register('contactNameDoNotKnow')} className="rounded" />
                    Do Not Know
                  </label>
                </div>

                {/* Organization Name */}
                <div id="field-contactOrganization" className={`bg-white rounded border p-4 space-y-2 ${contactOrganizationError ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}>
                  <div className="flex flex-col gap-1">
                    <label className="font-semibold text-sm text-gray-700">שם ארגון (Organization Name) <span className="text-gray-400 font-normal text-sm">(נדרש אחד מבין Contact Person / Organization)</span></label>
                    <input
                      type="text"
                      {...register('contactOrganization')}
                      disabled={watch('contactOrganizationDoNotKnow')}
                      className="rounded-md p-2 border border-gray-300 w-full disabled:bg-gray-100 disabled:text-gray-400"
                      dir="ltr"
                    />
                    {contactOrganizationError && <span className="text-red-500 text-xs">יש להזין שם ארגון, או פרטים מלאים של איש קשר</span>}
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                    <input type="checkbox" {...register('contactOrganizationDoNotKnow')} className="rounded" />
                    Do Not Know
                  </label>
                </div>

                {/* Relationship */}
                <div className="flex flex-col gap-1">
                  <label className="font-semibold text-sm text-gray-700">קשר אליך (Relationship to You)</label>
                  <select {...register('contactRelationship')} className="rounded-md p-2 border border-gray-300 bg-white">
                    <option value="">בחר...</option>
                    <option value="RELATIVE">קרוב משפחה</option>
                    <option value="SPOUSE">בן/בת זוג</option>
                    <option value="FRIEND">חבר/ה</option>
                    <option value="BUSINESS ASSOCIATE">שותף עסקי</option>
                    <option value="EMPLOYER">מעסיק</option>
                    <option value="SCHOOL OFFICIAL">נציג מוסד לימודי</option>
                    <option value="OTHER">אחר</option>
                  </select>
                </div>

                {/* Address & Phone */}
                <div className="bg-white rounded border border-gray-200 p-4 space-y-3">
                  <p className="font-semibold text-gray-700 text-sm">Address and Phone Number of Point of Contact</p>
                  <div className="grid grid-cols-1 gap-3">
                    <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב — שורה 1 (U.S. Street Address Line 1)" name="contactStreet" hint="לדוגמה: 123 Main St" />
                    <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב — שורה 2 (Line 2)" name="contactStreet2" optional />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <FormInput register={register} getFieldError={getFieldError} label="עיר (City)" name="contactCity" hint="לדוגמה: Miami" />
                      <FormSelect register={register} getFieldError={getFieldError} label="מדינה (State)" name="contactState" options={['- SELECT ONE -','AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','AS','GU','MP','PR','VI']} />
                    </div>
                    <FormInput register={register} getFieldError={getFieldError} label="מיקוד (ZIP Code — if known)" name="contactZip" hint="לדוגמה: 33101 או 33101-5678" optional naGate watch={watch} setValue={setValue} />
                    <FormInput register={register} getFieldError={getFieldError} label="טלפון (Phone Number)" name="contactPhone" hint="לדוגמה: 5555555555" />
                    {/* Email + Does Not Apply */}
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">אימייל (Email Address)</label>
                      <input
                        type="email"
                        {...register('contactEmail')}
                        disabled={watch('contactEmailDoesNotApply')}
                        className="rounded-md p-2 border border-gray-300 w-full disabled:bg-gray-100 disabled:text-gray-400"
                        dir="ltr"
                        placeholder="emailaddress@example.com"
                      />
                      <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer mt-1 self-end">
                        <input type="checkbox" {...register('contactEmailDoesNotApply')} className="rounded" />
                        Does Not Apply
                      </label>
                    </div>
                  </div>
                </div>
            </div>
          </section>

          <section id="section-family" className="space-y-6">
            <SectionCopyHeader
              title="מידע משפחתי: קרובים"
              sectionId="family"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
            />
            <p className="text-sm text-gray-600 bg-blue-50 border border-blue-100 rounded p-3">
              הערה: אנא מסור/י מידע על הוריך הביולוגיים. אם אומצת, מסור/י מידע על הוריך המאמצים.
            </p>

            {/* ── Father ── */}
            <div className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
              <h3 className="font-bold text-lg">שם מלא ותאריך לידה — אב</h3>

              {/* Surnames */}
              <div className="flex flex-col gap-1">
                <label className="font-semibold text-sm text-gray-700">שם משפחה</label>
                <div className="flex items-center gap-3">
                  <input type="text" {...register('fatherSurnames')} disabled={watch('fatherSurnamesDoNotKnow')}
                    className={`rounded-md p-2 border flex-1 disabled:bg-gray-100 disabled:text-gray-400 ${translationErrors.has('fatherSurnames') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                    dir="ltr" placeholder="e.g., Hernandez Garcia" />
                  <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                    <input type="checkbox" {...register('fatherSurnamesDoNotKnow')} className="rounded" />
                    לא ידוע
                  </label>
                </div>
                {translationErrors.has('fatherSurnames') && <span className="text-red-500 text-xs">נדרש שם פרטי או שם משפחה</span>}
              </div>

              {/* Given Names */}
              <div className="flex flex-col gap-1">
                <label className="font-semibold text-sm text-gray-700">שם פרטי</label>
                <div className="flex items-center gap-3">
                  <input type="text" {...register('fatherGivenNames')} disabled={watch('fatherGivenNamesDoNotKnow')}
                    className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400"
                    dir="ltr" placeholder="e.g., Juan Miguel" />
                  <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                    <input type="checkbox" {...register('fatherGivenNamesDoNotKnow')} className="rounded" />
                    לא ידוע
                  </label>
                </div>
              </div>

              {/* Date of Birth */}
              <div className="flex flex-col gap-1">
                <div className="flex items-end gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <DateSelectInput label="תאריך לידה" name="fatherBirthDate" optional register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                  </div>
                  <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer pb-1">
                    <input type="checkbox" {...register('fatherBirthDateDoNotKnow')} className="rounded" />
                    לא ידוע
                  </label>
                </div>
              </div>

              {/* Is father in the U.S.? */}
              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אביך נמצא בארה״ב?" name="fatherInUS" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
              {w.fatherInUS === 'yes' && (
                <div className="pr-4 border-r-4 border-blue-400">
                  <FormSelect register={register} getFieldError={getFieldError} label="מעמד האב" name="fatherUSStatus"
                    options={[
                      { value: 'U.S. CITIZEN', label: 'אזרח אמריקאי' },
                      { value: 'U.S. LEGAL PERMANENT RESIDENT (LPR)', label: 'תושב קבע חוקי' },
                      { value: 'NONIMMIGRANT', label: 'שאינו מהגר' },
                      { value: 'OTHER/I DON\'T KNOW', label: 'אחר / לא יודע' },
                    ]} />
                </div>
              )}
            </div>

            {/* ── Mother ── */}
            <div className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
              <h3 className="font-bold text-lg">שם מלא ותאריך לידה — אם</h3>

              {/* Surnames */}
              <div className="flex flex-col gap-1">
                <label className="font-semibold text-sm text-gray-700">שם משפחה</label>
                <div className="flex items-center gap-3">
                  <input type="text" {...register('motherSurnames')} disabled={watch('motherSurnamesDoNotKnow')}
                    className={`rounded-md p-2 border flex-1 disabled:bg-gray-100 disabled:text-gray-400 ${translationErrors.has('motherSurnames') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                    dir="ltr" placeholder="e.g., Hernandez Garcia" />
                  <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                    <input type="checkbox" {...register('motherSurnamesDoNotKnow')} className="rounded" />
                    לא ידוע
                  </label>
                </div>
                {translationErrors.has('motherSurnames') && <span className="text-red-500 text-xs">נדרש שם פרטי או שם משפחה</span>}
              </div>

              {/* Given Names */}
              <div className="flex flex-col gap-1">
                <label className="font-semibold text-sm text-gray-700">שם פרטי</label>
                <div className="flex items-center gap-3">
                  <input type="text" {...register('motherGivenNames')} disabled={watch('motherGivenNamesDoNotKnow')}
                    className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400"
                    dir="ltr" placeholder="e.g., Juanita Miguel" />
                  <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                    <input type="checkbox" {...register('motherGivenNamesDoNotKnow')} className="rounded" />
                    לא ידוע
                  </label>
                </div>
              </div>

              {/* Date of Birth */}
              <div className="flex items-end gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <DateSelectInput label="תאריך לידה" name="motherBirthDate" optional register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                </div>
                <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer pb-1">
                  <input type="checkbox" {...register('motherBirthDateDoNotKnow')} className="rounded" />
                  לא ידוע
                </label>
              </div>

              {/* Is mother in the U.S.? */}
              <FormRadioGroup register={register} getFieldError={getFieldError} label="האם אמך נמצאת בארה״ב?" name="motherInUS" options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
              {w.motherInUS === 'yes' && (
                <div className="pr-4 border-r-4 border-blue-400">
                  <FormSelect register={register} getFieldError={getFieldError} label="מעמד האם" name="motherUSStatus"
                    options={[
                      { value: 'U.S. CITIZEN', label: 'אזרח אמריקאי' },
                      { value: 'U.S. LEGAL PERMANENT RESIDENT (LPR)', label: 'תושב קבע חוקי' },
                      { value: 'NONIMMIGRANT', label: 'שאינו מהגר' },
                      { value: 'OTHER/I DON\'T KNOW', label: 'אחר / לא יודע' },
                    ]} />
                </div>
              )}
            </div>

            {/* ── Q1: Immediate relatives (not parents) ── */}
            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם יש לך קרובי משפחה מדרגה ראשונה (לא כולל הורים) בארה״ב?"
              name="hasCloseRelativesInUS"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />

            {w.hasCloseRelativesInUS === 'yes' && (
              <div className="space-y-4 pl-2 border-r-4 border-blue-400 pr-4">
                <p className="text-sm text-gray-600">אנא מסור/י את הפרטים הבאים:</p>
                {usRelativeFields.map((field, index) => (
                  <div key={field.id} className="bg-gray-50 border border-gray-200 rounded p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-gray-700">קרוב/ה #{index + 1}</span>
                      {usRelativeFields.length > 1 && (
                        <button type="button" onClick={() => removeUSRelative(index)} className="text-red-500 text-sm hover:underline">הסר</button>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">שם משפחה {translationErrors.has(`usRelatives.${index}.surnames`) && <span className="text-red-500">*</span>}</label>
                      <input type="text" {...register(`usRelatives.${index}.surnames`)}
                        className={`rounded-md p-2 border w-full ${translationErrors.has(`usRelatives.${index}.surnames`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                        dir="ltr" />
                      {translationErrors.has(`usRelatives.${index}.surnames`) && <span className="text-red-500 text-xs">נדרש לפחות שם אחד</span>}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">שם פרטי</label>
                      <input type="text" {...register(`usRelatives.${index}.givenNames`)}
                        className="rounded-md p-2 border border-gray-300 w-full" dir="ltr" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">קשר אליך</label>
                      <select
                        {...register(`usRelatives.${index}.relationship`)}
                        className={`rounded-md p-2 border bg-white ${getFieldError(`usRelatives.${index}.relationship`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                      >
                        <option value="">בחר...</option>
                        <option value="SPOUSE">בן/בת זוג</option>
                        <option value="FIANCÉ/FIANCÉE">ארוס/ה</option>
                        <option value="CHILD">ילד/ה</option>
                        <option value="SIBLING">אח/ות</option>
                        <option value="PARENT">הורה</option>
                        <option value="OTHER RELATIVE">קרוב משפחה אחר</option>
                      </select>
                      {getFieldError(`usRelatives.${index}.relationship`) && (
                        <span className="text-red-500 text-xs">שדה חובה</span>
                      )}
                    </div>
                    <FormSelect register={register} getFieldError={getFieldError} label="מעמד הקרוב" name={`usRelatives.${index}.status`}
                      options={['- SELECT ONE -', 'U.S. CITIZEN', 'U.S. LEGAL PERMANENT RESIDENT (LPR)', 'NONIMMIGRANT', 'OTHER/I DON\'T KNOW']} />
                  </div>
                ))}
                <button type="button"
                  onClick={() => appendUSRelative({ surnames: '', givenNames: '', relationship: '', status: '' })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                  <span aria-hidden className="text-lg leading-none">+</span>
                  הוסף קרוב
                </button>
              </div>
            )}

            {/* ── Q2: Any other relatives — only shown if Q1 is NO ── */}
            {w.hasCloseRelativesInUS === 'no' && (
              <FormRadioGroup register={register} getFieldError={getFieldError}
                label="האם יש לך קרובים נוספים בארה״ב?"
                name="hasOtherRelativesInUS"
                options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
            )}
          </section>

          <section id="section-employment" className="space-y-4">
            <SectionCopyHeader
              title="תעסוקה / השכלה / הכשרה נוכחית"
              sectionId="employment"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
              onCopied={(_meta, values) => {
                const v = String(values?.currentOccupation || '')
                setOccupationCategory(WORK_OCCUPATIONS.includes(v) ? '__WORKING__' : (v || ''))
              }}
            />
            <p className="text-sm text-gray-600 bg-blue-50 border border-blue-100 rounded p-3">
              הערה: אנא מסור/י מידע על תעסוקתך או לימודיך הנוכחיים.
            </p>
            <div className="space-y-3 mb-4">
              {/* Level 1 — primary category */}
              <div className="flex flex-col">
                <label className="font-semibold mb-1 text-gray-700">
                  עיסוק עיקרי <span className="text-red-500" aria-hidden="true">*</span>
                </label>
                <select
                  required
                  aria-required="true"
                  value={occupationCategory}
                  onChange={(e) => {
                    const v = e.target.value
                    setOccupationCategory(v)
                    if (v !== '__WORKING__') {
                      setValue('currentOccupation', v, { shouldDirty: true, shouldValidate: true })
                    } else {
                      setValue('currentOccupation', '', { shouldDirty: true })
                    }
                  }}
                  className={`rounded-md p-2 border ${getFieldError('currentOccupation') && occupationCategory !== '__WORKING__' ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                >
                  <option value="">בחר...</option>
                  <option value="STUDENT">סטודנט/ית</option>
                  <option value="__WORKING__">עובד/ת</option>
                  <option value="NOT EMPLOYED">לא מועסק/ת</option>
                  <option value="RETIRED">פנסיה</option>
                  <option value="HOMEMAKER">עקר/עקרת בית</option>
                </select>
              </div>

              {/* Level 2 — specific work field (only when עובד/ת) */}
              {occupationCategory === '__WORKING__' && (
                <div className="flex flex-col pr-4 border-r-4 border-blue-300">
                  <label className="font-semibold mb-1 text-gray-700 text-sm">
                    תחום עיסוק <span className="text-red-500" aria-hidden="true">*</span>
                  </label>
                  <select
                    required
                    aria-required="true"
                    {...register('currentOccupation')}
                    className={`rounded-md p-2 border ${getFieldError('currentOccupation') ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                  >
                    <option value="">בחר תחום...</option>
                    <option value="AGRICULTURE">חקלאות</option>
                    <option value="ARTIST/PERFORMER">אמן / מבצע</option>
                    <option value="BUSINESS">עסקים</option>
                    <option value="COMMUNICATIONS">תקשורת</option>
                    <option value="COMPUTER SCIENCE">מדעי המחשב</option>
                    <option value="CULINARY/FOOD SERVICES">קולינריה / שירותי מזון</option>
                    <option value="EDUCATION">חינוך</option>
                    <option value="ENGINEERING">הנדסה</option>
                    <option value="GOVERNMENT">ממשלה / שירות ציבורי</option>
                    <option value="LEGAL PROFESSION">משפטים</option>
                    <option value="MEDICAL/HEALTH">רפואה / בריאות</option>
                    <option value="MILITARY">צבא</option>
                    <option value="NATURAL SCIENCE">מדעי הטבע</option>
                    <option value="PHYSICAL SCIENCES">מדעים פיזיקליים</option>
                    <option value="RELIGIOUS VOCATION">עיסוק דתי</option>
                    <option value="RESEARCH">מחקר</option>
                    <option value="SOCIAL SCIENCE">מדעי החברה</option>
                    <option value="OTHER">אחר</option>
                  </select>
                  {getFieldError('currentOccupation') && <span className="text-red-500 text-sm mt-1">שדה חובה</span>}
                </div>
              )}
              {getFieldError('currentOccupation') && occupationCategory !== '__WORKING__' && (
                <span className="text-red-500 text-sm">שדה חובה</span>
              )}
            </div>

            {/* Employed occupations → employer details */}
            {['AGRICULTURE','ARTIST/PERFORMER','BUSINESS','COMMUNICATIONS','COMPUTER SCIENCE','CULINARY/FOOD SERVICES','EDUCATION','ENGINEERING','GOVERNMENT','LEGAL PROFESSION','MEDICAL/HEALTH','MILITARY','NATURAL SCIENCE','PHYSICAL SCIENCES','RELIGIOUS VOCATION','RESEARCH','SOCIAL SCIENCE','OTHER'].includes(w.currentOccupation) && (
              <div className="space-y-4 bg-gray-50 p-4 rounded border border-gray-200">
                <FormInput register={register} getFieldError={getFieldError} label="שם המעסיק / מוסד הלימודים" name="employerName" />

                {/* Address sub-section */}
                <div className="bg-white rounded border border-gray-200 p-3 space-y-3">
                  <p className="text-sm font-semibold text-gray-600">כתובת המעסיק / מוסד הלימודים:</p>
                  <FormInput register={register} getFieldError={getFieldError} label="רחוב (שורה 1)" name="employerStreet" />
                  <FormInput register={register} getFieldError={getFieldError} label="רחוב (שורה 2)" name="employerStreet2" optional />
                  <FormInput register={register} getFieldError={getFieldError} label="עיר" name="employerCity" />
                  <div className="flex flex-col gap-1">
                    <label className="font-semibold text-sm text-gray-700">מחוז</label>
                    <div className="flex items-center gap-3">
                      <input type="text" {...register('employerState')} disabled={watch('employerStateDoesNotApply')}
                        className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                      <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" {...register('employerStateDoesNotApply')} className="rounded" />
                        לא רלוונטי
                      </label>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="font-semibold text-sm text-gray-700">מיקוד</label>
                    <div className="flex items-center gap-3">
                      <input type="text" {...register('employerZip')} disabled={watch('employerZipDoesNotApply')}
                        className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                      <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" {...register('employerZipDoesNotApply')} className="rounded" />
                        לא רלוונטי
                      </label>
                    </div>
                  </div>
                  <FormInput register={register} getFieldError={getFieldError} label="טלפון" name="employerPhone" />
                  <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="מדינה" name="employerCountry" />
                </div>

                <FormInput register={register} getFieldError={getFieldError} label="תפקיד / כותרת משרה" name="jobTitle" />

                <DateSelectInput label="תאריך תחילת עבודה" name="employmentStartDate" register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />

                {/* Monthly Income + Does Not Apply */}
                <div className="flex flex-col gap-1">
                  <label className="font-semibold text-sm text-gray-700">הכנסה חודשית במטבע מקומי</label>
                  <div className="flex items-center gap-3">
                    <input type="text" {...register('monthlySalaryGross')} disabled={watch('monthlySalaryDoesNotApply')}
                      className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                    <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" {...register('monthlySalaryDoesNotApply')} className="rounded" />
                      לא רלוונטי
                    </label>
                  </div>
                </div>

                <FormInput register={register} getFieldError={getFieldError} label="תיאור קצר של תפקידיך:" name="jobDuties" type="textarea" />
              </div>
            )}

            {/* STUDENT */}
            {w.currentOccupation === 'STUDENT' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded border border-gray-200">
                <h3 className="col-span-full font-bold text-lg">פרטי לימודים נוכחיים</h3>
                <FormInput register={register} getFieldError={getFieldError} label="שם מוסד הלימודים" name="studentInstitutionName" />
                <FormInput register={register} getFieldError={getFieldError} label="תחום לימוד / תואר" name="studentDegree" />
                <DateSelectInput label="תאריך תחילת לימודים" name="studentStartDate" register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                <FormInput register={register} getFieldError={getFieldError} label="טלפון המוסד" name="studentInstitutionPhone" />
                <FormInput register={register} getFieldError={getFieldError} label="כתובת רחוב המוסד" name="studentInstitutionStreet" />
                <FormInput register={register} getFieldError={getFieldError} label="עיר" name="studentInstitutionCity" />
                <FormInput register={register} getFieldError={getFieldError} label="הכנסה חודשית" name="studentMonthlyIncome" optional naGate watch={watch} setValue={setValue} />
              </div>
            )}

            {/* NOT EMPLOYED */}
            {w.currentOccupation === 'NOT EMPLOYED' && (
              <div className="bg-gray-50 p-4 rounded border border-gray-200">
                <FormInput register={register} getFieldError={getFieldError} label="סיבת אי-העסקה" name="unemploymentReason" type="textarea" optional naGate watch={watch} setValue={setValue} />
              </div>
            )}

            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם עבדת בעבר?"
              name="workedAnotherJobLast5Years"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />

            {w.workedAnotherJobLast5Years === 'yes' && (
              <div className="space-y-4">
                {previousEmploymentFields.map((field, i) => (
                  <div key={field.id} className="bg-gray-50 border border-gray-200 rounded p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-gray-700">פרטי מעסיק / תפקיד קודם:</p>
                      {previousEmploymentFields.length > 1 && (
                        <button type="button" onClick={() => removePreviousEmployment(i)} className="text-red-500 text-sm hover:underline">הסר</button>
                      )}
                    </div>

                    <FormInput register={register} getFieldError={getFieldError} label="שם המעסיק" name={`previousEmployments.${i}.employerName`} />

                    {/* Address */}
                    <div className="bg-white rounded border border-gray-200 p-3 space-y-3">
                      <FormInput register={register} getFieldError={getFieldError} label="רחוב (שורה 1)" name={`previousEmployments.${i}.street`} optional />
                      <FormInput register={register} getFieldError={getFieldError} label="רחוב (שורה 2)" name={`previousEmployments.${i}.street2`} optional />
                      <FormInput register={register} getFieldError={getFieldError} label="עיר" name={`previousEmployments.${i}.city`} optional />
                      <div className="flex flex-col gap-1">
                        <label className="font-semibold text-sm text-gray-700">מחוז</label>
                        <div className="flex items-center gap-3">
                          <input type="text" {...register(`previousEmployments.${i}.state`)} disabled={watch(`previousEmployments.${i}.stateDoesNotApply`)}
                            className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                          <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                            <input type="checkbox" {...register(`previousEmployments.${i}.stateDoesNotApply`)} className="rounded" />
                            לא רלוונטי
                          </label>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="font-semibold text-sm text-gray-700">מיקוד</label>
                        <div className="flex items-center gap-3">
                          <input type="text" {...register(`previousEmployments.${i}.zip`)} disabled={watch(`previousEmployments.${i}.zipDoesNotApply`)}
                            className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                          <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                            <input type="checkbox" {...register(`previousEmployments.${i}.zipDoesNotApply`)} className="rounded" />
                            לא רלוונטי
                          </label>
                        </div>
                      </div>
                      <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="מדינה" name={`previousEmployments.${i}.country`} optional />
                      <FormInput register={register} getFieldError={getFieldError} label="טלפון" name={`previousEmployments.${i}.phone`} optional />
                    </div>

                    <FormInput register={register} getFieldError={getFieldError} label="תפקיד" name={`previousEmployments.${i}.jobTitle`} />

                    {/* Supervisor Surnames */}
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">שם משפחה של הממונה</label>
                      <div className="flex items-center gap-3">
                        <input type="text" {...register(`previousEmployments.${i}.supervisorSurnames`)}
                          disabled={watch(`previousEmployments.${i}.supervisorSurnamesDoNotKnow`)}
                          className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                        <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                          <input type="checkbox" {...register(`previousEmployments.${i}.supervisorSurnamesDoNotKnow`)} className="rounded" />
                          לא ידוע
                        </label>
                      </div>
                    </div>

                    {/* Supervisor Given Names */}
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">שם פרטי של הממונה</label>
                      <div className="flex items-center gap-3">
                        <input type="text" {...register(`previousEmployments.${i}.supervisorGivenNames`)}
                          disabled={watch(`previousEmployments.${i}.supervisorGivenNamesDoNotKnow`)}
                          className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                        <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                          <input type="checkbox" {...register(`previousEmployments.${i}.supervisorGivenNamesDoNotKnow`)} className="rounded" />
                          לא ידוע
                        </label>
                      </div>
                    </div>

                    <DateSelectInput label="תאריך תחילת העסקה" name={`previousEmployments.${i}.dateFrom`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                    <DateSelectInput label="תאריך סיום העסקה" name={`previousEmployments.${i}.dateTo`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                    <FormInput register={register} getFieldError={getFieldError} label="תיאור קצר של תפקידיך:" name={`previousEmployments.${i}.duties`} type="textarea" />
                  </div>
                ))}
                <button type="button"
                  onClick={() => appendPreviousEmployment({ employerName: '', street: '', street2: '', city: '', state: '', stateDoesNotApply: true, zip: '', zipDoesNotApply: true, country: 'Israel', phone: '', jobTitle: '', supervisorSurnames: '', supervisorSurnamesDoNotKnow: false, supervisorGivenNames: '', supervisorGivenNamesDoNotKnow: false, dateFrom: '', dateTo: '', duties: '' })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                  <span aria-hidden className="text-lg leading-none">+</span>
                  הוסף מעסיק קודם נוסף
                </button>
              </div>
            )}
          </section>

          <section id="section-education" className="space-y-4">
            <SectionCopyHeader
              title="השכלה"
              sectionId="education"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
            />

            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם למדת במוסד חינוכי ברמת תיכון ומעלה?"
              name="hasEducation"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />

            {w.hasEducation === 'yes' && (
              <div className="space-y-4">
                <p className="text-sm text-gray-600">אנא מסור/י מידע על מוסדות הלימוד בהם למדת.</p>
                {educationRecordFields.map((field, i) => (
                  <div key={field.id} className="bg-gray-50 border border-gray-200 rounded p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm text-gray-700">מוסד #{i + 1}</span>
                      {educationRecordFields.length > 1 && (
                        <button type="button" onClick={() => removeEducationRecord(i)} className="text-red-500 text-sm hover:underline">הסר</button>
                      )}
                    </div>

                    <FormInput register={register} getFieldError={getFieldError} label="שם המוסד" name={`educationRecords.${i}.institutionName`} />

                    {/* Address */}
                    <div className="bg-white rounded border border-gray-200 p-3 space-y-3">
                      <FormInput register={register} getFieldError={getFieldError} label="רחוב (שורה 1)" name={`educationRecords.${i}.street`} optional />
                      <FormInput register={register} getFieldError={getFieldError} label="רחוב (שורה 2)" name={`educationRecords.${i}.street2`} optional />
                      <FormInput register={register} getFieldError={getFieldError} label="עיר" name={`educationRecords.${i}.city`} optional />
                      <div className="flex flex-col gap-1">
                        <label className="font-semibold text-sm text-gray-700">מחוז</label>
                        <div className="flex items-center gap-3">
                          <input type="text" {...register(`educationRecords.${i}.state`)} disabled={watch(`educationRecords.${i}.stateDoesNotApply`)}
                            className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                          <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                            <input type="checkbox" {...register(`educationRecords.${i}.stateDoesNotApply`)} className="rounded" />
                            לא רלוונטי
                          </label>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="font-semibold text-sm text-gray-700">מיקוד</label>
                        <div className="flex items-center gap-3">
                          <input type="text" {...register(`educationRecords.${i}.zip`)} disabled={watch(`educationRecords.${i}.zipDoesNotApply`)}
                            className="rounded-md p-2 border border-gray-300 flex-1 disabled:bg-gray-100 disabled:text-gray-400" dir="ltr" />
                          <label className="flex items-center gap-1 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                            <input type="checkbox" {...register(`educationRecords.${i}.zipDoesNotApply`)} className="rounded" />
                            לא רלוונטי
                          </label>
                        </div>
                      </div>
                      <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="מדינה" name={`educationRecords.${i}.country`} optional />
                    </div>

                    <FormInput register={register} getFieldError={getFieldError} label="תחום לימוד" name={`educationRecords.${i}.courseOfStudy`} />
                    <DateSelectInput label="תאריך תחילת לימודים" name={`educationRecords.${i}.dateFrom`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                    <DateSelectInput label="תאריך סיום לימודים" name={`educationRecords.${i}.dateTo`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                  </div>
                ))}
                <button type="button"
                  onClick={() => appendEducationRecord({ institutionName: '', street: '', street2: '', city: '', state: '', stateDoesNotApply: true, zip: '', zipDoesNotApply: false, country: '', courseOfStudy: '', dateFrom: '', dateTo: '' })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                  <span aria-hidden className="text-lg leading-none">+</span>
                  הוסף מוסד
                </button>
              </div>
            )}

            {/* Q: Clan or Tribe */}
            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם אתה שייך לשבט או קבוצה אתנית?"
              name="hasClanOrTribe"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
            {w.hasClanOrTribe === 'yes' && (
              <div className="pl-2 border-r-4 border-blue-400 pr-4">
                <FormInput register={register} getFieldError={getFieldError} label="שם השבט / הקבוצה" name="clanOrTribeName" />
              </div>
            )}

            {/* Languages — repeatable */}
            <div className={`space-y-2 ${translationErrors.has('languagesList.0.name') ? 'rounded-md bg-red-50 p-2' : ''}`}>
              <p className="font-semibold text-sm text-gray-700">שפות שאתה דובר <span className="text-red-500">*</span></p>
              {languagesListFields.map((field, i) => (
                <div key={field.id} className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded p-3">
                  <div className="flex flex-col gap-1 flex-1">
                    <SearchableSelect
                      label="שפה" name={`languagesList.${i}.name`} options={LANGUAGES_BILINGUAL}
                      register={register} setValue={setValue} watch={watch}
                      getFieldError={() => translationErrors.has(`languagesList.${i}.name`) || (i === 0 && translationErrors.has('languagesList.0.name')) ? { message: '' } : null}
                      placeholder="חפש שפה..."
                    />
                  </div>
                  {languagesListFields.length > 1 && (
                    <button type="button" onClick={() => removeLanguage(i)} className="text-red-500 text-sm hover:underline mt-5">הסר</button>
                  )}
                </div>
              ))}
              {translationErrors.has('languagesList.0.name') && <span className="text-red-500 text-xs">יש לפרט לפחות שפה אחת</span>}
              <button type="button" onClick={() => appendLanguage({ name: '' })}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                <span aria-hidden className="text-lg leading-none">+</span>
                הוסף שפה
              </button>
            </div>

            {/* Q: Countries visited last 5 years — repeatable */}
            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם ביקרת במדינות אחרות בחמש השנים האחרונות?"
              name="visitedAbroadLast5Years"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
            {w.visitedAbroadLast5Years === 'yes' && (
              <div className="space-y-2 pl-2 border-r-4 border-blue-400 pr-4">
                <p className="text-sm text-gray-600">רשימת מדינות שביקרת בהן</p>
                {countriesVisitedFields.map((field, i) => (
                  <div key={field.id} className="flex items-end gap-3 bg-gray-50 border border-gray-200 rounded p-3">
                    <div className="flex flex-col gap-1 flex-1">
                      <SearchableSelect
                        label="מדינה" name={`countriesVisited.${i}.country`} options={COUNTRIES_BILINGUAL}
                        register={register} setValue={setValue} watch={watch}
                        getFieldError={() => translationErrors.has(`countriesVisited.${i}.country`) || (i === 0 && translationErrors.has('countriesVisited.0.country')) ? { message: '' } : null}
                        placeholder="חפש מדינה בעברית..."
                      />
                    </div>
                    {countriesVisitedFields.length > 1 && (
                      <button type="button" onClick={() => removeCountryVisited(i)} className="text-red-500 text-sm hover:underline pb-2">הסר</button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => appendCountryVisited({ country: '' })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                  <span aria-hidden className="text-lg leading-none">+</span>
                  הוסף מדינה
                </button>
              </div>
            )}

            {/* Q: Organizations — repeatable, name only */}
            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם השתייכת, תרמת או עבדת עבור ארגון מקצועי, חברתי או צדקה?"
              name="hasOrganizations"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
            {w.hasOrganizations === 'yes' && (
              <div className="space-y-2 pl-2 border-r-4 border-blue-400 pr-4">
                <p className="text-sm text-gray-600">רשימת ארגונים</p>
                {organizationFields.map((field, i) => (
                  <div key={field.id} className="flex items-end gap-3 bg-gray-50 border border-gray-200 rounded p-3">
                    <div className="flex flex-col gap-1 flex-1">
                      <label className="font-semibold text-sm text-gray-700">שם הארגון {translationErrors.has(`organizations.${i}.name`) && <span className="text-red-500">*</span>}</label>
                      <input type="text" {...register(`organizations.${i}.name`)}
                        className={`rounded-md p-2 border w-full ${translationErrors.has(`organizations.${i}.name`) ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                        dir="ltr" />
                    </div>
                    {organizationFields.length > 1 && (
                      <button type="button" onClick={() => removeOrganization(i)} className="text-red-500 text-sm hover:underline pb-2">הסר</button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => appendOrganization({ name: '', type: '' })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                  <span aria-hidden className="text-lg leading-none">+</span>
                  הוסף ארגון
                </button>
              </div>
            )}

            {/* Q: Specialized skills */}
            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם יש לך כישורים מיוחדים כגון נשק חם, חומרי נפץ, גרעין, ביולוגיה או כימיה?"
              name="hasSpecializedSkills"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
            {w.hasSpecializedSkills === 'yes' && (
              <div className="pl-2 border-r-4 border-blue-400 pr-4">
                <FormInput register={register} getFieldError={getFieldError} label="הסבר" name="specializedSkillsDescription" type="textarea" />
              </div>
            )}

            {/* Q: Military service — repeatable */}
            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם שירתת בצבא?"
              name="servedInMilitary"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
            {w.servedInMilitary === 'yes' && (
              <div className="space-y-4 pl-2 border-r-4 border-blue-400 pr-4">
                <p className="text-sm text-gray-600">אנא מסור/י את פרטי השירות:</p>
                {militaryServiceFields.map((field, i) => (
                  <div key={field.id} className="bg-gray-50 border border-gray-200 rounded p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm text-gray-700">שירות #{i + 1}</span>
                      {militaryServiceFields.length > 1 && (
                        <button type="button" onClick={() => removeMilitaryService(i)} className="text-red-500 text-sm hover:underline">הסר</button>
                      )}
                    </div>
                    <CountrySelect register={register} setValue={setValue} watch={watch} getFieldError={getFieldError} label="מדינה" name={`militaryService.${i}.country`} />
                    <FormInput register={register} getFieldError={getFieldError} label="חיל / זרוע" name={`militaryService.${i}.branch`} />
                    <div className="flex flex-col gap-1">
                      <label className="font-semibold text-sm text-gray-700">דרגה</label>
                      <select {...register(`militaryService.${i}.rank`)} className="rounded-md p-2 border border-gray-300 bg-white" dir="ltr">
                        <option value="">-- בחר דרגה --</option>
                        {IDF_RANKS.map((r) => (
                          <option key={r.en} value={r.en}>{r.en} ({r.he})</option>
                        ))}
                      </select>
                    </div>
                    <FormInput register={register} getFieldError={getFieldError} label="התמחות צבאית" name={`militaryService.${i}.specialty`} optional naGate watch={watch} setValue={setValue} />
                    <DateSelectInput label="תאריך תחילת שירות" name={`militaryService.${i}.dateFrom`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                    <DateSelectInput label="תאריך סיום שירות" name={`militaryService.${i}.dateTo`} register={register} getFieldError={getFieldError} setValue={setValue} watch={watch} />
                  </div>
                ))}
                <button type="button"
                  onClick={() => appendMilitaryService({ country: '', branch: '', rank: '', specialty: '', specialtyNA: true, dateFrom: '', dateTo: '' })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                  <span aria-hidden className="text-lg leading-none">+</span>
                  הוסף שירות
                </button>
              </div>
            )}

            {/* Q: Paramilitary */}
            <FormRadioGroup register={register} getFieldError={getFieldError}
              label="האם שירתת, היית חבר, או היית מעורב ביחידה פרא-צבאית, קבוצת מורדים, או ארגון חמוש?"
              name="hasParamilitary"
              options={[{ label: 'כן', value: 'yes' }, { label: 'לא', value: 'no' }]} />
            {w.hasParamilitary === 'yes' && (
              <div className="pl-2 border-r-4 border-blue-400 pr-4">
                <FormInput register={register} getFieldError={getFieldError} label="הסבר" name="paramilitaryExplanation" type="textarea" />
              </div>
            )}
          </section>

          {/* Security and Background — collapsible */}
          <section id="section-security" className="space-y-4">
            <SectionCopyHeader
              title="Security and Background"
              sectionId="security"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
              onCopied={() => setSecuritySectionOpen(true)}
            />
            <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded p-3">
              NOTE: Provide the following security and background information. A visa may not be issued to persons who are within specific categories defined by law as inadmissible to the United States. While a YES answer does not automatically signify ineligibility for a visa, if you answer YES you may be required to personally appear before a consular officer.
            </p>

            {/* Priority questions — shown in Hebrew outside the toggle */}
            <div className="space-y-4 border border-orange-200 bg-orange-50 rounded-lg p-4">
              <p className="text-sm font-semibold text-orange-800">שאלות חשובות — יש לענות עליהן</p>
              <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                <FormRadioGroup register={register} getFieldError={getFieldError}
                  label="האם הורשעת בפשע כלשהו או נעצרת אי פעם?"
                  name="arrestedOrConvicted"
                  options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
                {w.arrestedOrConvicted === 'yes' && (
                  <FormInput register={register} getFieldError={getFieldError} label="הסבר" name="arrestedOrConvictedExplanation" type="textarea" />
                )}
              </div>
              <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                <FormRadioGroup register={register} getFieldError={getFieldError}
                  label="האם שהית בארצות הברית ללא אישור חוקי, או הפרת תנאי ויזה?"
                  name="illegalStayInUS"
                  options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]} />
              </div>
            </div>

            {/* Toggle */}
            <div className="flex items-center gap-6 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <span className="font-semibold text-gray-700 text-sm">האם אחת מהשאלות הבאות מתאימה לך?</span>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                <input
                  type="radio"
                  name="securitySectionToggle"
                  checked={!securitySectionOpen}
                  onChange={() => setSecuritySectionOpen(false)}
                  className="accent-green-600 w-4 h-4"
                />
                לא — תשובתי לכל השאלות היא "No"
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                <input
                  type="radio"
                  name="securitySectionToggle"
                  checked={securitySectionOpen}
                  onChange={() => setSecuritySectionOpen(true)}
                  className="accent-red-600 w-4 h-4"
                />
                כן — ברצוני למלא את שאלות האבטחה
              </label>
            </div>

            {securitySectionOpen && (
              <div className="space-y-8">
                {/* Part 1 */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-gray-700 text-base border-b pb-1">Part 1 — Medical & Health</h3>
                  <div className="space-y-4">
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
                      <FormRadioGroup
                        register={register}
                        getFieldError={getFieldError}
                        label="Do you have a communicable disease of public health significance? (Communicable diseases of public significance include chancroid, gonorrhea, granuloma inguinale, infectious leprosy, lymphogranuloma venereum, infectious stage syphilis, active tuberculosis, and other diseases as determined by the Department of Health and Human Services.)"
                        name="communicableDisease"
                        options={[{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]}
                      />
                      {w.communicableDisease === 'yes' && (
                        <FormInput register={register} getFieldError={getFieldError} label="Explain" name="communicableDiseaseExplanation" type="textarea" />
                      )}
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
                      <FormRadioGroup
                        register={register}
                        getFieldError={getFieldError}
                        label="Do you have a mental or physical disorder that poses or is likely to pose a threat to the safety or welfare of yourself or others?"
                        name="mentalDisorder"
                        options={[{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]}
                      />
                      {w.mentalDisorder === 'yes' && (
                        <FormInput register={register} getFieldError={getFieldError} label="Explain" name="mentalDisorderExplanation" type="textarea" />
                      )}
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
                      <FormRadioGroup
                        register={register}
                        getFieldError={getFieldError}
                        label="Are you or have you ever been a drug abuser or addict?"
                        name="drugAbuser"
                        options={[{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]}
                      />
                      {w.drugAbuser === 'yes' && (
                        <FormInput register={register} getFieldError={getFieldError} label="Explain" name="drugAbuserExplanation" type="textarea" />
                      )}
                    </div>
                  </div>
                </div>

                {/* Part 2 */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-gray-700 text-base border-b pb-1">Part 2 — Criminal</h3>
                  <div className="space-y-4">
                    {[
                      { name: 'violatedControlledSubstances', expl: 'violatedControlledSubstancesExplanation', watch: w.violatedControlledSubstances, label: 'Have you ever violated, or engaged in a conspiracy to violate, any law relating to controlled substances?' },
                      { name: 'engagedInProstitution', expl: 'engagedInProstitutionExplanation', watch: w.engagedInProstitution, label: 'Are you coming to the United States to engage in prostitution or unlawful commercialized vice or have you been engaged in prostitution or procuring prostitutes within the past 10 years?' },
                      { name: 'moneyLaundering', expl: 'moneyLaunderingExplanation', watch: w.moneyLaundering, label: 'Have you ever been involved in, or do you seek to engage in, money laundering?' },
                      { name: 'humanTrafficking', expl: 'humanTraffickingExplanation', watch: w.humanTrafficking, label: 'Have you ever committed or conspired to commit a human trafficking offense in the United States or outside the United States?' },
                      { name: 'aidedHumanTrafficking', expl: 'aidedHumanTraffickingExplanation', watch: w.aidedHumanTrafficking, label: 'Have you ever knowingly aided, abetted, assisted or colluded with an individual who has committed, or conspired to commit a severe human trafficking offense in the United States or outside the United States?' },
                      { name: 'spouseOfTrafficker', expl: 'spouseOfTraffickerExplanation', watch: w.spouseOfTrafficker, label: 'Are you the spouse, son, or daughter of an individual who has committed or conspired to commit a human trafficking offense in the United States or outside the United States and have you within the last five years, knowingly benefited from the trafficking activities?' },
                    ].map(q => (
                      <div key={q.name} className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
                        <FormRadioGroup register={register} getFieldError={getFieldError} label={q.label} name={q.name} options={[{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]} />
                        {q.watch === 'yes' && (
                          <FormInput register={register} getFieldError={getFieldError} label="Explain" name={q.expl} type="textarea" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Part 3 */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-gray-700 text-base border-b pb-1">Part 3 — Security & Human Rights</h3>
                  <div className="space-y-4">
                    {[
                      { name: 'espionage', expl: 'espionageExplanation', watch: w.espionage, label: 'Do you seek to engage in espionage, sabotage, export control violations, or any other illegal activity while in the United States?' },
                      { name: 'terroristActivities', expl: 'terroristActivitiesExplanation', watch: w.terroristActivities, label: 'Do you seek to engage in terrorist activities while in the United States or have you ever engaged in terrorist activities?' },
                      { name: 'supportedTerrorists', expl: 'supportedTerroristsExplanation', watch: w.supportedTerrorists, label: 'Have you ever or do you intend to provide financial assistance or other support to terrorists or terrorist organizations?' },
                      { name: 'terroristMember', expl: 'terroristMemberExplanation', watch: w.terroristMember, label: 'Are you a member or representative of a terrorist organization?' },
                      { name: 'spouseOfTerrorist', expl: 'spouseOfTerroristExplanation', watch: w.spouseOfTerrorist, label: 'Are you the spouse, son, or daughter of an individual who has engaged in terrorist activity, including providing financial assistance or other support to terrorists or terrorist organizations, in the last five years?' },
                      { name: 'genocide', expl: 'genocideExplanation', watch: w.genocide, label: 'Have you ever ordered, incited, committed, assisted, or otherwise participated in genocide?' },
                      { name: 'torture', expl: 'tortureExplanation', watch: w.torture, label: 'Have you ever committed, ordered, incited, assisted, or otherwise participated in torture?' },
                      { name: 'extrajudicialKillings', expl: 'extrajudicialKillingsExplanation', watch: w.extrajudicialKillings, label: 'Have you committed, ordered, incited, assisted, or otherwise participated in extrajudicial killings, political killings, or other acts of violence?' },
                      { name: 'childSoldiers', expl: 'childSoldiersExplanation', watch: w.childSoldiers, label: 'Have you ever engaged in the recruitment or the use of child soldiers?' },
                      { name: 'religiousFreedomViolations', expl: 'religiousFreedomViolationsExplanation', watch: w.religiousFreedomViolations, label: 'Have you, while serving as a government official, been responsible for or directly carried out, at any time, particularly severe violations of religious freedom?' },
                      { name: 'populationControls', expl: 'populationControlsExplanation', watch: w.populationControls, label: 'Have you ever been directly involved in the establishment or enforcement of population controls forcing a woman to undergo an abortion against her free choice or a man or a woman to undergo sterilization against his or her free will?' },
                      { name: 'organTransplantation', expl: 'organTransplantationExplanation', watch: w.organTransplantation, label: 'Have you ever been directly involved in the coercive transplantation of human organs or bodily tissue?' },
                    ].map(q => (
                      <div key={q.name} className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
                        <FormRadioGroup register={register} getFieldError={getFieldError} label={q.label} name={q.name} options={[{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]} />
                        {q.watch === 'yes' && (
                          <FormInput register={register} getFieldError={getFieldError} label="Explain" name={q.expl} type="textarea" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Part 4 */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-gray-700 text-base border-b pb-1">Part 4 — Immigration Violations</h3>
                  <div className="space-y-4">
                    {[
                      { name: 'immigrationFraud', expl: 'immigrationFraudExplanation', watch: w.immigrationFraud, label: 'Have you ever sought to obtain or assist others to obtain a visa, entry into the United States, or any other United States immigration benefit by fraud or willful misrepresentation or other unlawful means?' },
                      { name: 'deportedFromCountry', expl: 'deportedFromCountryExplanation', watch: w.deportedFromCountry, label: 'Have you ever been removed or deported from any country?' },
                    ].map(q => (
                      <div key={q.name} className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
                        <FormRadioGroup register={register} getFieldError={getFieldError} label={q.label} name={q.name} options={[{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]} />
                        {q.watch === 'yes' && (
                          <FormInput register={register} getFieldError={getFieldError} label="Explain" name={q.expl} type="textarea" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Part 5 */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-gray-700 text-base border-b pb-1">Part 5 — Other</h3>
                  <div className="space-y-4">
                    {[
                      { name: 'withheldCustody', expl: 'withheldCustodyExplanation', watch: w.withheldCustody, label: 'Have you ever withheld custody of a U.S. citizen child outside the United States from a person granted legal custody by a U.S. court?' },
                      { name: 'votedIllegally', expl: 'votedIllegallyExplanation', watch: w.votedIllegally, label: 'Have you voted in the United States in violation of any law or regulation?' },
                      { name: 'renouncedCitizenship', expl: 'renouncedCitizenshipExplanation', watch: w.renouncedCitizenship, label: 'Have you ever renounced United States citizenship for the purposes of avoiding taxation?' },
                    ].map(q => (
                      <div key={q.name} className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
                        <FormRadioGroup register={register} getFieldError={getFieldError} label={q.label} name={q.name} options={[{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]} />
                        {q.watch === 'yes' && (
                          <FormInput register={register} getFieldError={getFieldError} label="Explain" name={q.expl} type="textarea" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          <section id="section-social" className="space-y-4">
            <SectionCopyHeader
              title="רשתות חברתיות"
              sectionId="social"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
            />
            <p className="text-sm text-gray-600">
              בחר את פלטפורמות המדיה החברתית בהן השתמשת במהלך 5 השנים האחרונות והזן את שם המשתמש שלך. אל תמסור סיסמאות.
            </p>
            <div className="space-y-3">
              {socialMediaAccountFields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">פלטפורמה (Social Media Provider/Platform)</label>
                    <select
                      {...register(`socialMediaAccounts.${index}.platform`)}
                      className="w-full rounded-md p-2 border border-gray-300 text-sm bg-white"
                      dir="ltr"
                    >
                      <option value="">-- SELECT ONE --</option>
                      <option>Facebook</option>
                      <option>Instagram</option>
                      <option>Twitter / X</option>
                      <option>LinkedIn</option>
                      <option>YouTube</option>
                      <option>TikTok</option>
                      <option>Snapchat</option>
                      <option>Pinterest</option>
                      <option>Reddit</option>
                      <option>Tumblr</option>
                      <option>Flickr</option>
                      <option>Vine</option>
                      <option>Myspace</option>
                      <option>Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">שם משתמש (Social Media Identifier)</label>
                    <input
                      {...register(`socialMediaAccounts.${index}.identifier`)}
                      placeholder="@username"
                      dir="ltr"
                      className="w-full rounded-md p-2 border border-gray-300 text-sm"
                    />
                  </div>
                  {socialMediaAccountFields.length > 1 && (
                    <button type="button" onClick={() => removeSocialMediaAccount(index)} className="pb-1 text-sm text-red-500 hover:text-red-700 font-medium">הסר ✕</button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => appendSocialMediaAccount({ platform: '', identifier: '' })}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
              >
                <span aria-hidden className="text-lg leading-none">+</span>
                הוסף פלטפורמה
              </button>
            </div>

            {/* Websites / Other Apps */}
            <div className="pt-2 border-t border-gray-200">
              <FormRadioGroup
                register={register}
                getFieldError={getFieldError}
                label="האם ברצונך לספק מידע על נוכחותך באתרים אחרים / אפליקציות (יצירה ושיתוף תוכן) ב-5 השנים האחרונות?"
                name="hasWebsiteContent"
                options={[{ label: 'לא', value: 'no' }, { label: 'כן', value: 'yes' }]}
              />
              {w.hasWebsiteContent === 'yes' && (
                <div className="mt-2 space-y-2 border-r-2 border-blue-200 pr-3">
                  {websiteContentFields.map((field, index) => (
                    <div key={field.id} className="flex gap-2 items-center">
                      <input
                        {...register(`websiteContentList.${index}.url`)}
                        placeholder="לדוגמה: https://myblog.com"
                        dir="ltr"
                        className="flex-1 rounded-md p-2 border border-gray-300 text-sm"
                      />
                      {websiteContentFields.length > 1 && (
                        <button type="button" onClick={() => removeWebsiteContent(index)} className="text-sm text-red-500 hover:text-red-700">הסר ✕</button>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => appendWebsiteContent({ url: '' })} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ הוסף אתר</button>
                </div>
              )}
            </div>
          </section>

          <section id="section-interview" className="space-y-4">
            <SectionCopyHeader
              title="מיקום ראיון"
              sectionId="interview"
              setValue={setValue}
              excludePathname={loadedBlobKeyRef.current}
              excludeFormId={formUUIDRef.current || storageFormId}
            />
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

          <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-gray-800">תמונת המבקש</h2>
            <p className="text-sm text-gray-600">תמונת פנים ברורה של מבקש הוויזה (פורמט JPEG/PNG מומלץ).</p>
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
          </section>

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
              <div className="flex gap-2 flex-wrap">
                {translateUi.text ? (
                  <button
                    type="button"
                    title="Download the translated text file, then run: npm run autofill -- --input ~/Downloads/translated.txt"
                    className="text-sm px-3 py-1.5 rounded-md border border-amber-500 text-amber-700 hover:bg-amber-50 flex items-center gap-1.5"
                    onClick={() => {
                      const blob = new Blob([translateUi.text], { type: 'text/plain' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = 'translated.txt'
                      a.click()
                      URL.revokeObjectURL(url)
                    }}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide bg-amber-100 text-amber-600 border border-amber-400 rounded px-1 py-0.5 leading-none">Experimental</span>
                    Auto-fill DS-160
                  </button>
                ) : null}
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
