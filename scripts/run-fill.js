import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const fillScript = path.join(repoRoot, 'autofill', 'fill-ds160.js')
export const profileDir = path.join(os.homedir(), 'Library/Application Support/DS160-Fill-Chrome')

export function fillEnv(base = process.env) {
  return {
    ...base,
    DS160_HEADED: '1',
    DS160_ISOLATED_CHROME: '1',
    DS160_CHROME_PROFILE: profileDir,
  }
}

export function startFill(inputFile, { onChunk } = {}) {
  if (!fs.existsSync(fillScript)) {
    throw new Error(`Fill script missing: ${fillScript}`)
  }
  fs.mkdirSync(profileDir, { recursive: true })
  const logsDir = path.join(repoRoot, 'autofill-output', 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = path.parse(inputFile).name.replace(/[^\w.-]+/g, '_') || 'fill'
  const logPath = path.join(logsDir, `fill-${base}-${stamp}.log`)
  const latestPath = path.join(logsDir, 'fill-latest.log')
  const logFile = fs.createWriteStream(logPath)
  logFile.write(`# fill-ds160 ${new Date().toISOString()}\n# input ${inputFile}\n\n`)

  const child = spawn(process.execPath, [fillScript, '--input', inputFile], {
    cwd: repoRoot,
    env: fillEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const forward = (buf) => {
    if (onChunk) onChunk(buf.toString())
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  child.stdout.pipe(logFile)
  child.stderr.pipe(logFile)

  const done = new Promise((resolve) => {
    child.on('exit', (code) => {
      logFile.end()
      try { fs.copyFileSync(logPath, latestPath) } catch { /* ignore */ }
      resolve({ code: code ?? 1, logPath })
    })
  })

  return {
    child,
    logPath,
    done,
    kill() {
      try { child.kill('SIGTERM') } catch { /* already exited */ }
    },
  }
}
