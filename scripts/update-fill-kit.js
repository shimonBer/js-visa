/**
 * Download the private `worker` branch when a fill-ds160 kit opens.
 * Worker kits have no .git folder. A checkout (this repo on a dev machine) is left alone.
 *
 *   node scripts/update-fill-kit.js
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const UPDATE_REPO = 'shimonBer/js-visa'
export const UPDATE_BRANCH = 'worker'

const PRESERVE = new Set([
  '.env',
  '.git',
  'node_modules',
  'autofill-output',
  'people',
  'graphify-out',
])

export function isPreservedRel(rel) {
  const top = String(rel).split(/[/\\]/)[0]
  if (!top || top === '.' || top === '..') return true
  if (PRESERVE.has(top)) return true
  if (top.startsWith('.env')) return true
  return false
}

export function kitShaPath(repoRoot) {
  return path.join(repoRoot, 'autofill-output', '.fill-kit-sha')
}

function lockPath(repoRoot) {
  return path.join(repoRoot, 'autofill-output', '.fill-kit-update.lock')
}

function readSha(repoRoot) {
  const file = kitShaPath(repoRoot)
  if (!fs.existsSync(file)) return ''
  return fs.readFileSync(file, 'utf8').trim()
}

function writeSha(repoRoot, sha) {
  const file = kitShaPath(repoRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${sha}\n`)
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fill-ds160-updater',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function githubError(status, action) {
  if (status === 401 || status === 403) {
    return new Error('GitHub rejected DS160_UPDATE_TOKEN (needs contents:read on js-visa)')
  }
  return new Error(`GitHub ${status} while ${action}`)
}

async function fetchRemoteSha(token, fetchImpl) {
  const url = `https://api.github.com/repos/${UPDATE_REPO}/commits/${UPDATE_BRANCH}`
  const res = await fetchImpl(url, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  })
  if (!res.ok) throw githubError(res.status, 'checking for an update')
  const body = await res.json()
  const sha = typeof body?.sha === 'string' ? body.sha.trim() : ''
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('GitHub update response had no commit sha')
  return sha
}

async function downloadTarball(token, dest, fetchImpl) {
  const url = `https://api.github.com/repos/${UPDATE_REPO}/tarball/${UPDATE_BRANCH}`
  const res = await fetchImpl(url, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(120_000),
    redirect: 'follow',
  })
  if (!res.ok) throw githubError(res.status, 'downloading the update')
  if (!res.body) throw new Error('GitHub update download was empty')
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
}

function extractTarball(archive, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const result = spawnSync('tar', ['-xzf', archive, '-C', dest], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error((result.stderr || 'Could not unpack the update').trim())
  }
}

function findSourceRoot(extractedDir) {
  const dirs = fs.readdirSync(extractedDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  if (dirs.length !== 1) throw new Error('Update archive had an unexpected layout')
  return path.join(extractedDir, dirs[0].name)
}

function walkFiles(root, onFile, base = root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    const rel = path.relative(base, full)
    if (entry.isDirectory()) {
      if (isPreservedRel(rel)) continue
      walkFiles(full, onFile, base)
      continue
    }
    if (entry.isFile() && !isPreservedRel(rel)) onFile(full)
  }
}

function removeEmptyDirs(root, base = root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    const rel = path.relative(base, full)
    if (isPreservedRel(rel)) continue
    removeEmptyDirs(full, base)
    if (fs.readdirSync(full).length === 0) fs.rmdirSync(full)
  }
}

export function applyExtractedTree(destRoot, sourceRoot) {
  if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) {
    throw new Error('Update archive is missing package.json')
  }
  const sourceFiles = new Set()
  walkFiles(sourceRoot, (full) => {
    const rel = path.relative(sourceRoot, full)
    sourceFiles.add(rel)
    const target = path.join(destRoot, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(full, target)
  })
  walkFiles(destRoot, (full) => {
    const rel = path.relative(destRoot, full)
    if (!sourceFiles.has(rel)) fs.rmSync(full, { force: true })
  })
  removeEmptyDirs(destRoot)
}

function readLock(repoRoot) {
  const file = path.join(repoRoot, 'package-lock.json')
  if (!fs.existsSync(file)) return ''
  return fs.readFileSync(file, 'utf8')
}

function npmInstall(repoRoot) {
  const result = spawnSync('npm', ['install'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error('npm install failed')
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function acquireLock(repoRoot, steal = true) {
  const file = lockPath(repoRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' })
    return file
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
    let pid = 0
    try {
      pid = Number(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
    if (steal && !pidAlive(pid)) {
      fs.rmSync(file, { force: true })
      return acquireLock(repoRoot, false)
    }
    return null
  }
}

function releaseLock(file) {
  if (file) fs.rmSync(file, { force: true })
}

async function defaultMaterialize({ token, fetchImpl, tmpDir }) {
  const archive = path.join(tmpDir, 'update.tgz')
  const extracted = path.join(tmpDir, 'extract')
  await downloadTarball(token, archive, fetchImpl)
  extractTarball(archive, extracted)
  return findSourceRoot(extracted)
}

/**
 * @returns {Promise<{ restart: boolean, busy: boolean }>}
 */
export async function updateFillKit({
  repoRoot,
  token = process.env.DS160_UPDATE_TOKEN || '',
  alreadyRestarted = process.env.DS160_FILL_UPDATED === '1',
  fetchImpl = globalThis.fetch,
  log = console.log,
  warn = console.error,
  materialize = defaultMaterialize,
  runInstall = npmInstall,
} = {}) {
  if (alreadyRestarted) return { restart: false, busy: false }
  if (!repoRoot || fs.existsSync(path.join(repoRoot, '.git'))) return { restart: false, busy: false }
  if (!String(token).trim()) {
    log('fill-ds160 update skipped (no DS160_UPDATE_TOKEN)')
    return { restart: false, busy: false }
  }

  let remoteSha = ''
  try {
    log('fill-ds160 checking for updates…')
    remoteSha = await fetchRemoteSha(token, fetchImpl)
  } catch (err) {
    warn(`fill-ds160 update skipped: ${err.message || err}`)
    return { restart: false, busy: false }
  }

  if (readSha(repoRoot) === remoteSha) {
    log('fill-ds160 is up to date')
    return { restart: false, busy: false }
  }

  const lock = acquireLock(repoRoot)
  if (!lock) {
    log('fill-ds160 update already in progress')
    return { restart: false, busy: true }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-ds160-update-'))
  try {
    log(`fill-ds160 updating to ${remoteSha.slice(0, 7)}…`)
    const sourceRoot = await materialize({ token, fetchImpl, tmpDir, remoteSha })
    const lockBefore = readLock(repoRoot)
    applyExtractedTree(repoRoot, sourceRoot)
    if (readLock(repoRoot) !== lockBefore) runInstall(repoRoot)
    writeSha(repoRoot, remoteSha)
    log(`fill-ds160 updated to ${remoteSha.slice(0, 7)}`)
    return { restart: true, busy: false }
  } catch (err) {
    warn(`fill-ds160 update failed: ${err.message || err}`)
    return { restart: false, busy: false }
  } finally {
    releaseLock(lock)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await updateFillKit({ repoRoot })
  if (result.restart) console.log('Restart fill-ds160 to use the new code.')
}
