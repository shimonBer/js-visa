import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_ID_RE = /^[A-Z0-9]{10}$/

export function repoRootFrom(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..')
}

export function parseApplicationId(value = '') {
  const id = String(value).trim().toUpperCase()
  return APP_ID_RE.test(id) ? id : ''
}

/** Last Application ID mentioned in fill logs — including failure / retrieve lines. */
export function extractApplicationIdFromLog(text) {
  const raw = String(text || '')
  const patterns = [
    /DS160_APPLICATION_ID=([A-Z0-9]{10})/gi,
    /Application ID(?:\s+for\s+(?:manual|later)\s+retrieve)?:\s*([A-Z0-9]{10})/gi,
    /Using Application ID\s+([A-Z0-9]{10})/gi,
    /Retrieving application\s+([A-Z0-9]{10})/gi,
    /retrieving Application ID\s+([A-Z0-9]{10})/gi,
  ]
  let last = ''
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(raw))) {
      const id = parseApplicationId(match[1])
      if (id) last = id
    }
  }
  return last
}

export function appIdStorePath(repoRoot) {
  return path.join(repoRoot, 'autofill-output', 'application-ids.json')
}

export function eventsPath(repoRoot) {
  return path.join(repoRoot, 'autofill-output', 'fill-events.jsonl')
}

function emptyStore() {
  return { byPath: {}, byName: {}, byFormId: {} }
}

export function loadAppIdStore(repoRoot) {
  const file = appIdStorePath(repoRoot)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      byPath: parsed?.byPath && typeof parsed.byPath === 'object' ? parsed.byPath : {},
      byName: parsed?.byName && typeof parsed.byName === 'object' ? parsed.byName : {},
      byFormId: parsed?.byFormId && typeof parsed.byFormId === 'object' ? parsed.byFormId : {},
    }
  } catch {
    return emptyStore()
  }
}

function writeStore(repoRoot, store) {
  const file = appIdStorePath(repoRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`)
}

function entryAppId(entry) {
  if (!entry || entry.forgotten) return ''
  if (typeof entry === 'string') return parseApplicationId(entry)
  return parseApplicationId(entry.appId)
}

function storeMarksForgotten(store, { filePath = '', name = '', formId = '' } = {}) {
  const resolved = filePath ? path.resolve(filePath) : ''
  const base = name || (resolved ? path.basename(resolved) : '')
  const entries = [
    formId ? store.byFormId[formId] : null,
    resolved ? store.byPath[resolved] : null,
    base ? store.byName[base] : null,
  ]
  return entries.some((entry) => entry && entry.forgotten)
}

function storeHit(store, { filePath = '', name = '', formId = '' } = {}) {
  if (formId && store.byFormId[formId]) return entryAppId(store.byFormId[formId])
  const resolved = filePath ? path.resolve(filePath) : ''
  if (resolved && store.byPath[resolved]) return entryAppId(store.byPath[resolved])
  const base = name || (resolved ? path.basename(resolved) : '')
  if (base && store.byName[base]) return entryAppId(store.byName[base])
  return ''
}

function lookupFromEvents(repoRoot, { filePath = '', name = '', formId = '' } = {}) {
  const file = eventsPath(repoRoot)
  if (!fs.existsSync(file)) return ''
  const resolved = filePath ? path.resolve(filePath) : ''
  const base = name || (resolved ? path.basename(resolved) : '')
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const event = JSON.parse(line)
      const id = parseApplicationId(event.appId) || extractApplicationIdFromLog(event.logExcerpt)
      if (!id) continue
      if (formId && event.formId && event.formId === formId) return id
      if (resolved && event.path && path.resolve(event.path) === resolved) return id
      if (base && event.name === base) return id
    } catch {
      /* ignore malformed event lines */
    }
  }
  return ''
}

export function peekApplicationId(repoRoot, keys = {}) {
  return storeHit(loadAppIdStore(repoRoot), keys)
}

export function lookupApplicationId(repoRoot, keys = {}) {
  if (storeMarksForgotten(loadAppIdStore(repoRoot), keys)) return ''
  const stored = peekApplicationId(repoRoot, keys)
  if (stored) return stored
  const fromEvents = lookupFromEvents(repoRoot, keys)
  if (fromEvents) {
    rememberApplicationId(repoRoot, { ...keys, appId: fromEvents })
    return fromEvents
  }
  return ''
}

export function rememberApplicationId(repoRoot, { filePath = '', name = '', formId = '', appId = '' } = {}) {
  const id = parseApplicationId(appId)
  if (!id) return ''
  const store = loadAppIdStore(repoRoot)
  const resolved = filePath ? path.resolve(filePath) : ''
  const base = name || (resolved ? path.basename(resolved) : '')
  const entry = { appId: id, updatedAt: new Date().toISOString() }
  if (resolved) store.byPath[resolved] = entry
  if (base) store.byName[base] = entry
  if (formId) store.byFormId[formId] = entry
  writeStore(repoRoot, store)
  return id
}

/** Drop the saved Application ID so the next run starts a new CEAC application. */
export function forgetApplicationId(repoRoot, { filePath = '', name = '', formId = '' } = {}) {
  const store = loadAppIdStore(repoRoot)
  const resolved = filePath ? path.resolve(filePath) : ''
  const base = name || (resolved ? path.basename(resolved) : '')
  const mark = { forgotten: true, updatedAt: new Date().toISOString() }
  if (resolved) store.byPath[resolved] = mark
  if (base) store.byName[base] = mark
  if (formId) store.byFormId[formId] = mark
  writeStore(repoRoot, store)
}

export function embeddedFormIdFromText(text) {
  return String(text || '').match(/^#\s*DS160_FORM_ID=([a-zA-Z0-9_-]+)\s*$/m)?.[1] || ''
}
