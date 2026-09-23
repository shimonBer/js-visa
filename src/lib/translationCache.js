import { serializeFormValuesForJson } from './serializeFormPayload.js'
import { firstFile } from './uploadFormDocuments.js'

const DB_NAME = 'ds160_form_app'
const DB_VERSION = 1
const STORE = 'translation_cache'
const TRANSLATION_SCHEMA_VERSION = 'israeli-passport-book-na-v5'

const DOC_FIELDS = [
  'passportScan',
  'existingVisaScan',
  'socialSecurityScan',
  'americanLicenseScan',
  'extraDocumentScan1',
  'extraDocumentScan2',
  'extraDocumentScan3',
]

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'storageFormId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortForJson(value[key])
    }
    return out
  }
  return value
}

function isBrowserFile(value) {
  return typeof File !== 'undefined' && value instanceof File
}

/** Stable id for a file the user picked. Restored copies must not use this. */
export function fileSignature(file) {
  if (!isBrowserFile(file)) return ''
  return `${file.name}:${file.size}:${file.lastModified}`
}

/**
 * Signatures for files that already match the stored S3 object
 * (just uploaded, or restored from S3). Those fields fingerprint as the S3 key.
 * @param {Record<string, unknown>} values
 * @param {string[]} [fields]
 */
export function cleanSignaturesForFiles(values, fields = DOC_FIELDS) {
  const out = {}
  for (const field of fields) {
    const sig = fileSignature(firstFile(values?.[field]))
    if (sig) out[field] = sig
  }
  return out
}

/**
 * Fingerprint of form JSON + document identity.
 * A file marked clean (uploaded or restored) is identified by its S3 key, so
 * reloading the form does not look like a change. A newly picked file uses
 * its local signature until it is uploaded.
 * @param {Record<string, unknown>} values
 * @param {{ field?: string, key?: string }[]} [s3Documents]
 * @param {Record<string, string>} [cleanFileSigs]
 */
export function buildTranslationFingerprint(values, s3Documents = [], cleanFileSigs = {}) {
  const { data } = serializeFormValuesForJson(values)
  const keys = new Map()
  for (const doc of s3Documents || []) {
    if (doc && typeof doc.field === 'string' && typeof doc.key === 'string' && doc.key) {
      keys.set(doc.field, doc.key)
    }
  }
  const docs = DOC_FIELDS.map((field) => {
    const key = keys.get(field) || ''
    const file = firstFile(values?.[field])
    const sig = fileSignature(file)
    const base = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    const matchesStoredObject = !!(file && base && file.name === base)
    if (sig && cleanFileSigs?.[field] !== sig && !matchesStoredObject) return `${field}:local:${sig}`
    return `${field}:s3:${key}`
  })
  return [TRANSLATION_SCHEMA_VERSION, JSON.stringify(sortForJson(data)), ...docs].join('\x1e')
}

/**
 * Server-safe translation record stored on the form blob (no PDF bytes).
 * @param {unknown} raw
 * @returns {{ fingerprint: string, translated: string, attachmentLabels: string[], savedAt: string | null } | null}
 */
export function normalizeStoredTranslation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const fingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint : ''
  const translated = typeof raw.translated === 'string' ? raw.translated : ''
  if (!fingerprint || !translated.trim()) return null
  return {
    fingerprint,
    translated,
    attachmentLabels: Array.isArray(raw.attachmentLabels)
      ? raw.attachmentLabels.map((label) => String(label)).filter(Boolean)
      : [],
    savedAt: typeof raw.savedAt === 'string' && raw.savedAt ? raw.savedAt : null,
  }
}

/**
 * @param {string} storageFormId
 * @returns {Promise<{ fingerprint: string, translated: string, attachmentLabels: string[], pdfBase64: string } | null>}
 */
export async function loadTranslationCache(storageFormId) {
  const id = String(storageFormId || 'incomplete')
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => {
      const row = req.result
      if (!row || typeof row.fingerprint !== 'string') resolve(null)
      else
        resolve({
          fingerprint: row.fingerprint,
          translated: String(row.translated ?? ''),
          attachmentLabels: Array.isArray(row.attachmentLabels) ? row.attachmentLabels : [],
          pdfBase64: String(row.pdfBase64 ?? ''),
        })
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * @param {string} storageFormId
 * @param {{ fingerprint: string, translated: string, attachmentLabels: string[], pdfBase64: string }} record
 */
export async function saveTranslationCache(storageFormId, record) {
  const id = String(storageFormId || 'incomplete')
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({
      storageFormId: id,
      fingerprint: record.fingerprint,
      translated: record.translated,
      attachmentLabels: record.attachmentLabels,
      pdfBase64: record.pdfBase64,
      savedAt: Date.now(),
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
