#!/usr/bin/env node
/**
 * Local fill-ds160 window: load one or more translated files and run them in order.
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

const PORT = Number(process.env.DS160_FILL_UI_PORT || 47821)
const HOST = '127.0.0.1'
const uiDir = path.dirname(fileURLToPath(import.meta.url))
const indexFile = path.join(uiDir, 'index.html')
const inboxDir = path.join(repoRoot, 'autofill-output', 'inbox')
const wantOpen = process.argv.includes('--open')

const queue = []
const logLines = ['Ready.']
let running = false
let stopRequested = false
let currentJob = null

function publicState() {
  return {
    running,
    log: logLines.slice(-200).join(''),
    queue: queue.map(({ id, name, path: filePath, status, error }) => ({
      id,
      name,
      path: filePath,
      status,
      error: error || '',
    })),
  }
}

function appendLog(text) {
  logLines.push(text)
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400)
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
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

function osascript(source) {
  const result = spawnSync('osascript', ['-e', source], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim()
    if (/User canceled|-128/i.test(err)) {
      const cancel = new Error('canceled')
      cancel.canceled = true
      throw cancel
    }
    throw new Error(err || 'macOS dialog failed')
  }
  return (result.stdout || '').trim()
}

function chooseFiles() {
  const downloads = path.join(os.homedir(), 'Downloads').replace(/\\/g, '/')
  const output = osascript(`
    set theFolder to POSIX file ${JSON.stringify(downloads)}
    set theFiles to choose file with prompt "Choose translated DS-160 files (first_last.txt)." with multiple selections allowed default location theFolder
    if class of theFiles is not list then set theFiles to {theFiles}
    set out to ""
    repeat with f in theFiles
      set out to out & POSIX path of f & linefeed
    end repeat
    return out
  `)
  return output.split(/\r?\n/).map((line) => line.replace(/\/$/, '')).filter(Boolean)
}

function displayName(filePath, text) {
  const base = path.basename(filePath)
  if (base && base.toLowerCase() !== 'translated.txt') return base
  return translatedDownloadFileName({ translatedText: text })
}

function addPath(filePath) {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`)
  if (queue.some((item) => item.path === resolved && (item.status === 'queued' || item.status === 'filling'))) {
    return
  }
  const text = fs.readFileSync(resolved, 'utf8')
  queue.push({
    id: randomUUID(),
    name: displayName(resolved, text),
    path: resolved,
    status: 'queued',
  })
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
  for (const file of files || []) {
    const original = String(file?.name || 'translated.txt')
    const text = String(file?.text || '')
    const named = translatedDownloadFileName({ translatedText: text })
    const base = named !== 'translated.txt' ? named : original.replace(/[^\w.-]+/g, '_')
    const fileName = base.toLowerCase().endsWith('.txt') ? base : `${base}.txt`
    const dest = uniqueInboxPath(fileName)
    fs.writeFileSync(dest, text)
    addPath(dest)
  }
}

async function runQueue() {
  if (running) return
  running = true
  stopRequested = false
  appendLog('\nStarting queue…\n')
  try {
    for (const item of queue) {
      if (item.status !== 'queued') continue
      if (stopRequested) {
        item.status = 'stopped'
        continue
      }
      item.status = 'filling'
      appendLog(`\n── ${item.name} ──\n`)
      currentJob = startFill(item.path, { onChunk: appendLog })
      const result = await currentJob.done
      currentJob = null
      if (stopRequested) {
        item.status = 'stopped'
        item.error = 'stopped'
      } else if (result.code === 0) {
        item.status = 'done'
      } else {
        item.status = 'failed'
        item.error = `exit ${result.code}`
        appendLog(`\nFailed: ${item.name} (exit ${result.code})\n`)
      }
    }
  } finally {
    running = false
    currentJob = null
    appendLog(stopRequested ? '\nStopped.\n' : '\nQueue finished.\n')
  }
}

function openUi(url) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (fs.existsSync(chrome)) {
    spawn(chrome, [`--app=${url}`, '--new-window', '--window-size=560,760'], {
      detached: true,
      stdio: 'ignore',
    }).unref()
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
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/pick-files') {
      if (process.platform !== 'darwin') {
        return json(res, 400, { error: 'File picker is Mac-only. Drop files onto this window instead.' })
      }
      const picked = chooseFiles()
      for (const filePath of picked) addPath(filePath)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/add-uploads') {
      const body = await readBody(req)
      await addUploads(body.files)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/remove') {
      const body = await readBody(req)
      const idx = queue.findIndex((item) => item.id === body.id)
      if (idx >= 0 && queue[idx].status !== 'filling') queue.splice(idx, 1)
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/clear-done') {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (['done', 'failed', 'stopped'].includes(queue[i].status)) queue.splice(i, 1)
      }
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (!queue.some((item) => item.status === 'queued')) {
        return json(res, 400, { error: 'Add at least one translated file.' })
      }
      runQueue().catch((err) => appendLog(`\n${err.message}\n`))
      return json(res, 200, publicState())
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      stopRequested = true
      currentJob?.kill()
      return json(res, 200, publicState())
    }
    json(res, 404, { error: 'Not found' })
  } catch (err) {
    if (err.canceled) return json(res, 200, publicState())
    json(res, 500, { error: err.message || 'Server error' })
  }
})

async function main() {
  if (await alreadyRunning()) {
    if (wantOpen) openUi(`http://${HOST}:${PORT}/`)
    console.log(`fill-ds160 UI already running at http://${HOST}:${PORT}/`)
    return
  }

  await new Promise((resolve, reject) => {
    server.listen(PORT, HOST, resolve)
    server.on('error', reject)
  })
  const url = `http://${HOST}:${PORT}/`
  console.log(`fill-ds160 UI: ${url}`)
  if (wantOpen) openUi(url)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
