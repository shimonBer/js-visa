import { serializeFormValuesForJson } from './serializeFormPayload.js'
import { firstFile } from './uploadFormDocuments.js'

const DB_NAME = 'ds160_form_app'
const DB_VERSION = 1
const STORE = 'translation_cache'

const DOC_FIELDS = ['passportScan', 'existingVisaScan', 'socialSecurityScan', 'americanLicenseScan']

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

/**
 * Fingerprint of form JSON + file metadata so we skip re-translating when unchanged.
 * @param {Record<string, unknown>} values
 */
export function buildTranslationFingerprint(values) {
  const { data, fileMeta } = serializeFormValuesForJson(values)
  const parts = [JSON.stringify(data), JSON.stringify(fileMeta ?? {})]
  for (const field of DOC_FIELDS) {
    const f = firstFile(values[field])
    if (f instanceof File) parts.push(`${field}:${f.name}:${f.size}:${f.lastModified}`)
    else parts.push(`${field}:`)
  }
  return parts.join('\x1e')
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
