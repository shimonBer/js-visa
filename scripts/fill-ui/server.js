#!/usr/bin/env node
import 'dotenv/config'
/**
 * Local fill-ds160 window: Hebrew play/stop per file.
 * Sequential by default; optional parallel (max 2) with separate Chrome profiles.
 *
 *   node scripts/fill-ui/server.js --open
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { translatedDownloadFileName } from '../../lib/translatedFileName.js'
import { repoRoot, startFill } from '../run-fill.js'
import {
  appendFillEvent,
  classifyFillResult,
  embeddedFormIdFromText,
  extractApplicationIdFromLog,
  lookupApplicationId,
  notifyCopy,
  notifyFillEvent,
  parseApplicationId,
  postFillWebhook,
  rememberApplicationId,
  forgetApplicationId,
} from './status.js'
import { emailFillEvent, logExcerpt } from './email.js'
import { publishFillRun } from './cloud-runs.js'
import {
  extractRunScreenshot,
  fileStem,
  groupFillRuns,
  intakeForPrior,
  isAutofillSourceName,
  isTodoItem,
  portalStatus,
  readFillEvents,
  shouldAutoPlayDownload,
  reviveQueueItem,
  selectionAfterStatus,
} from './runs.js'

const PORT = Number(process.env.DS160_FILL_UI_PORT || 47821)
const HOST = '127.0.0.1'
const uiDir = path.dirname(fileURLToPath(import.meta.url))
const indexFile = path.join(uiDir, 'index.html')
const inboxDir = path.join(repoRoot, 'autofill-output', 'inbox')
const queueFile = path.join(repoRoot, 'autofill-output', 'fill-queue.json')
const memoryFile = path.join(repoRoot, 'autofill-output', 'fill-memory.json')
const wantOpen = process.argv.includes('--open')

const queue = []
const playOrder = []
const active = new Map()
let pumping = false
let abortQueue = false
let parallelEnabled = false
let imported = {}
let runMemory = {}

function hydrateItemAppId(item) {
  if (item.appId) return item.appId
  const found = lookupApplicationId(repoRoot, {
    filePath: item.path,
    name: item.name,
    formId: item.formId,
  })
  if (found) item.appId = found
  return item.appId || ''
}

function publicState() {
  return {
    parallel: parallelEnabled,
    queue: queue.map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      status: item.status,
      selected: item.selected !== false,
      error: item.error || '',
      appId: hydrateItemAppId(item),
    })),
  }
}

function concurrency() {
  return parallelEnabled ? 2 : 1
}

function nextSlot() {
  const used = new Set([...active.values()].map((entry) => entry.slot))
  if (!used.has(1)) return 1
  if (concurrency() >= 2 && !used.has(2)) return 2
  return 0
}

function json(res, status, body, { cors = false } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*'
    headers['Access-Control-Allow-Private-Network'] = 'true'
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

function historyRuns() {
  return groupFillRuns(readFillEvents(repoRoot)).slice(0, 120).map((run) => ({
    ...run,
    shotUrl: run.shotFile ? `/api/shot?id=${encodeURIComponent(run.id)}` : '',
  }))
}

function serveShot(res, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) {
    json(res, 400, { error: 'Invalid run id' }, { cors: true })
    return
  }
  const file = path.join(shotsDir(), `${id}.jpg`)
  if (!file.startsWith(shotsDir()) || !fs.existsSync(file)) {
    json(res, 404, { error: 'Screenshot not found' }, { cors: true })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  })
  fs.createReadStream(file).pipe(res)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function rememberItemAppId(item, appId) {
  const id = parseApplicationId(appId)
  if (!id) return
  item.appId = id
  rememberApplicationId(repoRoot, {
    filePath: item.path,
    name: item.name,
    formId: item.formId,
    appId: id,
  })
}

function persistQueue() {
  fs.mkdirSync(path.dirname(queueFile), { recursive: true })
  const body = {
    parallel: parallelEnabled,
    imported,
    queue: queue.map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      status: item.status,
      selected: item.selected !== false,
      formId: item.formId || '',
      appId: item.appId || '',
      error: item.error || '',
      runId: item.runId || '',
      startedAt: item.startedAt || '',
      shotFile: item.shotFile || '',
    })),
  }
  fs.writeFileSync(queueFile, `${JSON.stringify(body, null, 2)}\n`)
}

function loadPersisted() {
  try {
    const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'))
    parallelEnabled = Boolean(saved.parallel)
    imported = saved.imported && typeof saved.imported === 'object' ? saved.imported : {}
    for (const item of saved.queue || []) {
      const revived = reviveQueueItem(item)
      if (revived) queue.push({ ...revived, id: revived.id || randomUUID() })
    }
  } catch {
    /* first open */
  }
  try {
    const saved = JSON.parse(fs.readFileSync(memoryFile, 'utf8'))
    if (saved && typeof saved === 'object') runMemory = saved
  } catch {
    runMemory = {}
  }
}

function memoryKeys({ formId = '', name = '' } = {}) {
  const keys = []
  if (formId) keys.push(`form:${formId}`)
  const stem = fileStem(name)
  if (stem) keys.push(`stem:${stem}`)
  return keys
}

function priorRun({ formId = '', name = '' } = {}) {
  for (const key of memoryKeys({ formId, name })) {
    if (runMemory[key]) return runMemory[key]
  }
  return null
}

function rememberRun(item) {
  if (!['succeeded', 'failed', 'blocked', 'stopped'].includes(item.status)) return
  const entry = {
    status: item.status,
    appId: item.appId || '',
    formId: item.formId || '',
    name: item.name || '',
    updatedAt: new Date().toISOString(),
  }
  for (const key of memoryKeys(item)) runMemory[key] = entry
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true })
  fs.writeFileSync(memoryFile, `${JSON.stringify(runMemory, null, 2)}\n`)
}

function noteImported(resolved, mtimeMs) {
  if (imported[resolved] === mtimeMs) return
  imported[resolved] = mtimeMs
  persistQueue()
}

function shotsDir() {
  return path.join(repoRoot, 'autofill-output', 'shots')
}

function rememberShot(item, logText) {
  const found = extractRunScreenshot(logText)
  if (!found || !item.runId || !fs.existsSync(found)) return ''
  fs.mkdirSync(shotsDir(), { recursive: true })
  const dest = path.join(shotsDir(), `${item.runId}.jpg`)
  if (path.resolve(found) !== path.resolve(dest)) fs.copyFileSync(found, dest)
  item.shotFile = `${item.runId}.jpg`
  return dest
}

function record(item, status, extra = {}) {
  item.status = status
  item.selected = selectionAfterStatus(status, item.selected)
  item.error = extra.reason || extra.error || ''
  rememberItemAppId(item, extra.appId || item.appId)
  const shotPath = status === 'filling' ? '' : rememberShot(item, extra.logText)
  const event = {
    name: item.name,
    status,
    runId: item.runId || '',
    appId: item.appId || extra.appId || '',
    formId: item.formId || '',
    reason: extra.reason || extra.error || '',
    path: item.path,
    logExcerpt: logExcerpt(extra.logText),
    shotFile: item.shotFile || '',
    startedAt: item.startedAt || '',
  }
  appendFillEvent(repoRoot, event)
  rememberRun(item)
  persistQueue()
  if (status !== 'filling') {
    notifyFillEvent({
      message: notifyCopy(status, item.name, event.reason),
      sound: status === 'failed' || status === 'blocked',
    })
  }
  postFillWebhook(event)
  emailFillEvent({ ...event, logText: extra.logText || '' }).catch(() => {})
  if (!item.runId) return
  publishFillRun({
    ...event,
    id: item.runId,
    ts: new Date().toISOString(),
    portalStatus: portalStatus(status),
    hasShot: Boolean(shotPath),
  }, { shotPath }).catch((err) => {
    console.error('[fill-ui] portal history', err?.message || err)
  })
}

function chooseFilesMac() {
  const downloads = path.join(os.homedir(), 'Downloads').replace(/\\/g, '/')
  const result = spawnSync('osascript', ['-e', `
    set theFolder to POSIX file ${JSON.stringify(downloads)}
    set theFiles to choose file with prompt "בחרו קבצי DS-160 מתורגמים" with multiple selections allowed default location theFolder
    if class of theFiles is not list then set theFiles to {theFiles}
    set out to ""
    repeat with f in theFiles
      set out to out & POSIX path of f & linefeed
    end repeat
    return out
  `], { encoding: 'utf8' })
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim()
    if (/User canceled|-128/i.test(err)) {
      const cancel = new Error('canceled')
      cancel.canceled = true
      throw cancel
    }
    throw new Error(err || 'בחירת קובץ נכשלה')
  }
  return (result.stdout || '').trim().split(/\r?\n/).map((line) => line.replace(/\/$/, '')).filter(Boolean)
}

function chooseFilesWindows() {
  const downloads = path.join(os.homedir(), 'Downloads')
  const tmp = path.join(os.tmpdir(), 'fill-ds160-pick.ps1')
  fs.writeFileSync(tmp, `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $true
$d.Title = 'בחרו קבצי DS-160 מתורגמים'
$d.Filter = 'Text (*.txt)|*.txt|All (*.*)|*.*'
$d.InitialDirectory = ${JSON.stringify(downloads)}
if ($d.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
$d.FileNames | ForEach-Object { $_ }
`)
  const result = spawnSync('powershell', ['-STA', '-NoProfile', '-File', tmp], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error((result.stderr || 'בחירת קובץ נכשלה').trim())
  return (result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function chooseFiles() {
  if (process.platform === 'darwin') return chooseFilesMac()
  if (process.platform === 'win32') return chooseFilesWindows()
  throw new Error('בחירת קבצים מהחלון זמינה במק וב-Windows. אפשר לגרור קבצים לכאן.')
}

function displayName(filePath, text) {
  const base = path.basename(filePath)
  if (base && base.toLowerCase() !== 'translated.txt') return base
  return translatedDownloadFileName({ translatedText: text })
}

function addPath(filePath, { fromScan = false } = {}) {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    if (fromScan) return false
    throw new Error(`הקובץ לא נמצא: ${resolved}`)
  }
  const mtimeMs = fs.statSync(resolved).mtimeMs
  if (fromScan && imported[resolved] === mtimeMs) return false
  if (queue.some((item) => item.path === resolved)) {
    noteImported(resolved, mtimeMs)
    return false
  }
  const text = fs.readFileSync(resolved, 'utf8')
  const name = displayName(resolved, text)
  const formId = embeddedFormIdFromText(text)
  if (formId && queue.some((item) => item.formId === formId)) {
    noteImported(resolved, mtimeMs)
    return false
  }
  const prior = priorRun({ formId, name })
  const intake = intakeForPrior(prior)
  const appId = lookupApplicationId(repoRoot, { filePath: resolved, name, formId }) || prior?.appId || ''
  queue.push({
    id: randomUUID(),
    name,
    path: resolved,
    status: intake.status,
    selected: intake.selected,
    formId,
    appId,
    error: '',
  })
  imported[resolved] = mtimeMs
  persistQueue()
  return true
}

const autoPlayedDownloads = new Set()

function autoPlayDownloaded(filePath) {
  const resolved = path.resolve(filePath)
  let item = queue.find((entry) => entry.path === resolved)
  if (!item) {
    let text = ''
    try { text = fs.readFileSync(resolved, 'utf8') } catch { return }
    const formId = embeddedFormIdFromText(text)
    if (formId) item = queue.find((entry) => entry.formId === formId)
  }
  if (!shouldAutoPlayDownload(item) || autoPlayedDownloads.has(item.id)) return
  autoPlayedDownloads.add(item.id)
  requestPlay(item.id)
}

function scanAutofillDownloads() {
  const downloads = path.join(os.homedir(), 'Downloads')
  if (!fs.existsSync(downloads)) return
  let names = []
  try { names = fs.readdirSync(downloads) } catch { return }
  for (const name of names) {
    if (!isAutofillSourceName(name)) continue
    const full = path.join(downloads, name)
    try {
      if (!fs.statSync(full).isFile()) continue
      addPath(full, { fromScan: true })
      autoPlayDownloaded(full)
    } catch {
      /* skip a file that is still being saved */
    }
  }
}

function uniqueInboxPath(fileName) {
  const dest = path.join(inboxDir, fileName)
  if (!fs.existsSync(dest)) return dest
  const parsed = path.parse(fileName)
  let n = 2
  let next = dest
  while (fs.existsSync(next)) {
    next = path.join(inboxDir, `${parsed.name}-${n}${parsed.ext}`)
    n += 1
  }
  return next
}

async function addUploads(files) {
  fs.mkdirSync(inboxDir, { recursive: true })
  const added = []
  for (const file of files || []) {
    const original = String(file?.name || 'translated.txt')
    const text = String(file?.text || '')
    if (!text.trim()) continue
    const formId = embeddedFormIdFromText(text)
    const existing = formId ? queue.find((item) => item.formId === formId) : null
    if (existing) {
      added.push({ id: existing.id, name: existing.name, status: existing.status })
      continue
    }
    const named = isAutofillSourceName(original)
      ? path.basename(original)
      : translatedDownloadFileName({ translatedText: text })
    const base = named && named.toLowerCase() !== 'translated.txt'
      ? named
      : original.replace(/[^\w.\- ()]+/g, '_')
    const fileName = base.toLowerCase().endsWith('.txt') ? base : `${base}.txt`
    const dest = uniqueInboxPath(fileName)
    fs.writeFileSync(dest, text)
    addPath(dest)
    const item = queue.find((entry) => entry.path === dest)
    if (item) added.push({ id: item.id, name: item.name, status: item.status })
  }
  return added
}

function nextQueued() {
  while (playOrder.length) {
    const id = playOrder[0]
    const item = queue.find((entry) => entry.id === id)
    if (item && item.status === 'queued') return item
    playOrder.shift()
  }
  return null
}

function requestPlay(id, { fresh = false } = {}) {
  const item = queue.find((entry) => entry.id === id)
  if (!item || item.status === 'filling') return
  item.selected = true
  item.fresh = Boolean(fresh)
  if (item.fresh) console.log(`[fill-ui] fresh start (no retrieve): ${item.name}`)
  item.status = 'queued'
  item.error = ''
  if (!playOrder.includes(id)) playOrder.push(id)
  persistQueue()
  pump()
}

function setSelected(id, selected) {
  const item = queue.find((entry) => entry.id === id)
  if (!item || item.status === 'filling') return
  item.selected = Boolean(selected)
  if (!item.selected && item.status === 'queued') {
    item.status = 'idle'
    dropFromPlayOrder(id)
  }
  persistQueue()
}

function forgetHistory(id) {
  const item = queue.find((entry) => entry.id === id)
  if (!item || item.status === 'filling') return
  if (item.status === 'queued') {
    item.status = 'idle'
    dropFromPlayOrder(id)
  }
  forgetApplicationId(repoRoot, {
    filePath: item.path,
    name: item.name,
    formId: item.formId,
  })
  for (const key of memoryKeys(item)) delete runMemory[key]
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true })
  fs.writeFileSync(memoryFile, `${JSON.stringify(runMemory, null, 2)}\n`)
  item.appId = ''
  item.status = 'idle'
  item.selected = true
  item.fresh = false
  item.error = ''
  persistQueue()
}

function setSelectedAll(selected) {
  for (const item of queue) {
    if (!isTodoItem(item)) continue
    setSelected(item.id, selected)
  }
}

function requestStop(id) {
  const item = queue.find((entry) => entry.id === id)
  if (!item) return
  if (item.status === 'queued') {
    item.status = 'idle'
    const idx = playOrder.indexOf(id)
    if (idx >= 0) playOrder.splice(idx, 1)
    persistQueue()
    return
  }
  const running = active.get(id)
  if (item.status === 'filling' && running) {
    running.stopRequested = true
    running.job?.kill()
  }
  persistQueue()
}

function dropFromPlayOrder(id) {
  const idx = playOrder.indexOf(id)
  if (idx >= 0) playOrder.splice(idx, 1)
}

function requestRemove(id) {
  const item = queue.find((entry) => entry.id === id)
  if (!item) return
  if (item.status === 'filling') {
    throw new Error('עצרו את המילוי לפני מחיקה')
  }
  dropFromPlayOrder(id)
  const at = queue.findIndex((entry) => entry.id === id)
  if (at >= 0) queue.splice(at, 1)
  persistQueue()
}

function playAll() {
  for (const item of queue) {
    if (item.selected === false) continue
    if (['filling', 'queued'].includes(item.status)) continue
    requestPlay(item.id)
  }
}

function stopAll() {
  abortQueue = true
  playOrder.length = 0
  for (const item of queue) {
    if (item.status === 'queued') {
      item.status = 'stopped'
      item.error = 'stopped'
      item.selected = false
      rememberRun(item)
    }
  }
  for (const id of [...active.keys()]) requestStop(id)
  persistQueue()
}

function setParallel(enabled) {
  parallelEnabled = Boolean(enabled)
  persistQueue()
  pump()
}

function clearDone() {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (['succeeded', 'failed', 'stopped', 'blocked'].includes(queue[i].status)) {
      dropFromPlayOrder(queue[i].id)
      queue.splice(i, 1)
    }
  }
  persistQueue()
}

function runItem(item, slot) {
  const entry = { slot, job: null, stopRequested: false, finished: null }
  item.runId = randomUUID()
  item.startedAt = new Date().toISOString()
  item.shotFile = ''
  const fresh = Boolean(item.fresh)
  item.fresh = false
  item.selected = true
  item.status = 'filling'
  if (!fresh && !item.appId) {
    rememberItemAppId(item, lookupApplicationId(repoRoot, {
      filePath: item.path,
      name: item.name,
      formId: item.formId,
    }))
  }
  active.set(item.id, entry)
  entry.finished = (async () => {
    record(item, 'filling')
    try {
      if (entry.stopRequested) {
        record(item, 'stopped', { reason: 'stopped' })
        return
      }
      entry.job = startFill(item.path, {
        slot,
        fresh,
        appId: fresh ? '' : item.appId,
        onChunk(text) {
          rememberItemAppId(item, extractApplicationIdFromLog(text))
        },
      })
      if (entry.stopRequested) entry.job.kill()
      const result = await entry.job.done
      const classified = classifyFillResult({
        code: result.code,
        logText: result.logText,
        stopped: entry.stopRequested,
      })
      record(item, classified.status, { ...classified, logText: result.logText })
    } catch (err) {
      record(item, entry.stopRequested ? 'stopped' : 'failed', {
        reason: err.message || 'fill error',
      })
    } finally {
      active.delete(item.id)
    }
  })()
  return entry.finished
}

function maybeStartJobs() {
  while (!abortQueue && active.size < concurrency()) {
    const item = nextQueued()
    if (!item) break
    const slot = nextSlot()
    if (!slot) break
    playOrder.shift()
    runItem(item, slot)
  }
}

async function pump() {
  maybeStartJobs()
  if (pumping) return
  pumping = true
  try {
    while (active.size > 0) {
      await Promise.race([...active.values()].map((entry) => entry.finished))
      if (abortQueue) break
      maybeStartJobs()
    }
    if (active.size) {
      await Promise.allSettled([...active.values()].map((entry) => entry.finished))
    }
  } finally {
    pumping = false
    abortQueue = false
    if (nextQueued()) pump()
  }
}

function chromeBins() {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || ''
    const pf = process.env.PROGRAMFILES || ''
    const pf86 = process.env['PROGRAMFILES(X86)'] || ''
    return [
      path.join(local, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
    ]
  }
  return []
}

function focusExistingUi() {
  const needle = `127.0.0.1:${PORT}`
  if (process.platform === 'darwin') {
    const script = `
      set needle to ${JSON.stringify(needle)}
      if application "Google Chrome" is running then
        tell application "Google Chrome"
          repeat with w in windows
            try
              if (URL of active tab of w) contains needle then
                set index of w to 1
                activate
                return "focused"
              end if
            end try
          end repeat
        end tell
      end if
      return "missing"
    `
    const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8' })
    if ((result.stdout || '').includes('focused')) return 'focused'
    if ((result.stdout || '').includes('missing')) return 'missing'
    return 'error'
  }
  if (process.platform === 'win32') {
    const script = `
      $shell = New-Object -ComObject WScript.Shell
      if ($shell.AppActivate('fill-ds160')) { 'focused' } else { 'missing' }
    `
    const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    if ((result.stdout || '').includes('focused')) return 'focused'
    if ((result.stdout || '').includes('missing')) return 'missing'
    return 'error'
  }
  return 'missing'
}

function revealUi(url) {
  if (focusExistingUi() === 'focused') return
  openUi(url)
}

function openUi(url) {
  const chrome = chromeBins().find((bin) => bin && fs.existsSync(bin))
  if (chrome) {
    spawn(chrome, [`--app=${url}`, '--new-window', '--window-size=640,720'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
}

async function alreadyRunning() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/health`)
    if (!res.ok) return false
    const body = await res.json()
    return body?.ok === true
  } catch {
    return false
  }
}

function serveIndex(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(fs.readFileSync(indexFile))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveIndex(res)
    }
    if (req.method === 'OPTIONS' && ['/api/runs', '/api/shot', '/api/health', '/api/add-uploads', '/api/play'].includes(url.pathname)) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true }, { cors: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, publicState())
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      return json(res, 200, { runs: historyRuns() }, { cors: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/shot') {
      return serveShot(res, url.searchParams.get('id'))
    }
    if (req.method === 'POST' && url.pathname === '/api/pick-files') {
      const picked = chooseFiles()
      for (const filePath of picked) addPath(filePath)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/add-uploads') {
      const body = await readBody(req)
      const added = await addUploads(body.files)
      return json(res, 200, { ...publicState(), added }, { cors: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/play') {
      const body = await readBody(req)
      requestPlay(body.id, { fresh: Boolean(body.fresh) })
      return json(res, 200, publicState(), { cors: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/forget') {
      const body = await readBody(req)
      forgetHistory(body.id)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/select') {
      const body = await readBody(req)
      setSelected(body.id, body.selected)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/select-all') {
      const body = await readBody(req)
      setSelectedAll(body.selected)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const body = await readBody(req)
      requestStop(body.id)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/remove') {
      const body = await readBody(req)
      requestRemove(body.id)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/play-all') {
      playAll()
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/stop-all') {
      stopAll()
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/clear-done') {
      clearDone()
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/parallel') {
      const body = await readBody(req)
      setParallel(body.enabled)
      return json(res, 200, publicState())
    }
    json(res, 404, { error: 'Not found' })
  } catch (err) {
    if (err.canceled) return json(res, 200, publicState())
    json(res, 400, { error: err.message || 'Server error' })
  }
})

async function main() {
  if (await alreadyRunning()) {
    if (wantOpen) revealUi(`http://${HOST}:${PORT}/`)
    console.log(`fill-ds160 UI already running at http://${HOST}:${PORT}/`)
    return
  }

  loadPersisted()
  await new Promise((resolve, reject) => {
    server.listen(PORT, HOST, resolve)
    server.on('error', reject)
  })
  scanAutofillDownloads()
  setInterval(scanAutofillDownloads, 4000)
  const url = `http://${HOST}:${PORT}/`
  console.log(`fill-ds160 UI: ${url}`)
  if (wantOpen) openUi(url)
}

main().catch((err) => {
  if (err?.code === 'EADDRINUSE') {
    revealUi(`http://${HOST}:${PORT}/`)
    process.exit(0)
  }
  console.error(err.message || err)
  process.exit(1)
})
