const STATUS_HEBREW = {
  400: 'הבקשה אינה תקינה.',
  401: 'נדרשת התחברות מחדש.',
  403: 'אין הרשאה לבצע את הפעולה.',
  404: 'הפריט לא נמצא.',
  408: 'הבקשה ארכה יותר מדי זמן.',
  413: 'הקובץ גדול מדי.',
  429: 'יותר מדי בקשות כרגע. נסה שוב בעוד כמה רגעים.',
  500: 'תקלה בשרת. נסה שוב.',
  502: 'השירות החיצוני לא זמין כרגע. נסה שוב בעוד כמה רגעים.',
  503: 'השירות לא זמין כרגע. נסה שוב בעוד כמה רגעים.',
  504: 'השירות לא הגיב בזמן. נסה שוב.',
}

function statusHebrew(code) {
  return STATUS_HEBREW[Number(code)] || `קוד שגיאה ${code}.`
}

/** @type {[RegExp, (match: string, ...groups: string[]) => string][]} */
const REPLACEMENTS = [
  [/OpenAI request failed \((\d+)\)/gi, (_, code) => `הבקשה ל-OpenAI נכשלה. ${statusHebrew(code)}`],
  [/Translate failed \((\d+)\)/gi, (_, code) => `התרגום נכשל. ${statusHebrew(code)}`],
  [/Foreign passport extract failed \((\d+)\)/gi, (_, code) => `זיהוי הדרכון הזר נכשל. ${statusHebrew(code)}`],
  [/Passport extract failed \((\d+)\)/gi, (_, code) => `זיהוי הדרכון נכשל. ${statusHebrew(code)}`],
  [/License extract failed \((\d+)\)/gi, (_, code) => `זיהוי הרישיון נכשל. ${statusHebrew(code)}`],
  [/SSN extract failed \((\d+)\)/gi, (_, code) => `זיהוי כרטיס הביטוח הלאומי נכשל. ${statusHebrew(code)}`],
  [/Visa extract failed \((\d+)\)/gi, (_, code) => `זיהוי הוויזה נכשל. ${statusHebrew(code)}`],
  [/PDF upload failed \((\d+)\)/gi, (_, code) => `העלאת ה-PDF נכשלה. ${statusHebrew(code)}`],
  [/Upload failed \((\d+)\)/gi, (_, code) => `העלאת הקובץ נכשלה. ${statusHebrew(code)}`],
  [/Blob save failed \((\d+)\)/gi, (_, code) => `שמירת הטופס נכשלה. ${statusHebrew(code)}`],
  [/List failed \((\d+)\)/gi, (_, code) => `טעינת הרשימה נכשלה. ${statusHebrew(code)}`],
  [/Load failed \((\d+)\)/gi, (_, code) => `הטעינה נכשלה. ${statusHebrew(code)}`],
  [/Delete failed \((\d+)\)/gi, (_, code) => `המחיקה נכשלה. ${statusHebrew(code)}`],
  [/Download failed \((\d+)\)/gi, (_, code) => `ההורדה נכשלה. ${statusHebrew(code)}`],
  [/Lookup failed \((\d+)\)/gi, (_, code) => `החיפוש נכשל. ${statusHebrew(code)}`],
  [/Request failed \((\d+)\)/gi, (_, code) => `הבקשה נכשלה. ${statusHebrew(code)}`],
  [/[\w #.-]+ failed \((\d+)\)/gi, (_, code) => `הפעולה נכשלה. ${statusHebrew(code)}`],
  [/Unsupported file type[^.]*/gi, () => 'סוג הקובץ אינו נתמך. יש להעלות JPEG, PNG, GIF, WebP או PDF'],
  [/Invalid file/gi, () => 'הקובץ אינו תקין'],
  [/FileReader failed/gi, () => 'לא ניתן לקרוא את הקובץ'],
  [/S3 download is not configured/gi, () => 'ההורדה אינה מוגדרת'],
  [/local fill rejected the request/gi, () => 'המילוי המקומי דחה את הבקשה'],
  [/No sessionId returned from create/gi, () => 'בדיקת I-94 לא החזירה מזהה'],
  [/I-94 lookup timed out after (\d+) min/gi, (_, mins) => `בדיקת I-94 נעצרה אחרי ${mins} דקות`],
  [/Monday API returned an unexpected success payload/gi, () => 'התקבלה תשובה לא צפויה מ-Monday'],
  [/Monday API returned invalid JSON \((\d+)\)/gi, (_, code) => `התקבלה תשובה לא תקינה מ-Monday. ${statusHebrew(code)}`],
  [/Monday lookup returned invalid JSON \((\d+)\)/gi, (_, code) => `התקבלה תשובה לא תקינה מ-Monday. ${statusHebrew(code)}`],
  [/Failed to fetch|NetworkError|network error|Load failed/gi, () => 'אין חיבור לשרת. בדוק את הרשת ונסה שוב'],
  [/invalid JSON/gi, () => 'התקבלה תשובה לא תקינה'],
]

/**
 * Turn a failure string into Hebrew for the error modal.
 * Messages that are already Hebrew stay as they are, with known English fragments translated.
 * @param {unknown} raw
 */
export function toHebrewError(raw) {
  let message = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!message) return 'אירעה שגיאה. נסה שוב.'

  for (const [pattern, replace] of REPLACEMENTS) {
    message = message.replace(pattern, replace)
  }

  message = message
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)

  const hebrew = (message.match(/[\u0590-\u05FF]/g) || []).length
  const latin = (message.match(/[A-Za-z]/g) || []).length
  if (hebrew > 0 && hebrew >= latin) return message

  const code = message.match(/\b([45]\d{2})\b/)
  if (code) return `אירעה שגיאה. ${statusHebrew(code[1])}`
  return 'אירעה שגיאה. נסה שוב.'
}
