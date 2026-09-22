import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromeProfileDirForSlot } from './fill-ui/status.js'
import { parseApplicationId } from '../autofill/application-id-store.js'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const fillScript = path.join(repoRoot, 'autofill', 'fill-ds160.js')

export function fillEnv(base = process.env, profile = chromeProfileDirForSlot(1)) {
  return {
    ...base,
    DS160_HEADED: '1',
    DS160_ISOLATED_CHROME: '1',
    DS160_CHROME_PROFILE: profile,
  }
}

export function fillCliArgs(inputFile, { appId = '', fresh = false } = {}) {
  const args = [fillScript, '--input', inputFile]
  if (fresh) {
    args.push('--fresh')
    return args
  }
  const id = parseApplicationId(appId)
  if (id) args.push('--retrieve', '--app-id', id)
  return args
}

export function startFill(inputFile, { onChunk, slot = 1, appId = '', fresh = false } = {}) {
  if (!fs.existsSync(fillScript)) {
    throw new Error(`Fill script missing: ${fillScript}`)
  }
  const profileDir = chromeProfileDirForSlot(slot)
  fs.mkdirSync(profileDir, { recursive: true })
  const logsDir = path.join(repoRoot, 'autofill-output', 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = path.parse(inputFile).name.replace(/[^\w.-]+/g, '_') || 'fill'
  const logPath = path.join(logsDir, `fill-${base}-${stamp}.log`)
  const latestPath = path.join(logsDir, 'fill-latest.log')
  const logFile = fs.createWriteStream(logPath)
  const resumeId = fresh ? '' : parseApplicationId(appId)
  logFile.write(
    `# fill-ds160 ${new Date().toISOString()}\n# input ${inputFile}\n# slot ${slot}` +
    `${fresh ? '\n# fresh' : ''}` +
    `${resumeId ? `\n# retrieve ${resumeId}` : ''}\n\n`,
  )

  const child = spawn(process.execPath, fillCliArgs(inputFile, { appId: resumeId, fresh }), {
    cwd: repoRoot,
    env: fillEnv(process.env, profileDir),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let logText = ''
  const forward = (buf) => {
    const text = buf.toString()
    logText += text
    if (onChunk) onChunk(text)
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  child.stdout.pipe(logFile)
  child.stderr.pipe(logFile)

  const done = new Promise((resolve) => {
    child.on('exit', (code) => {
      logFile.end()
      try { fs.copyFileSync(logPath, latestPath) } catch { /* ignore */ }
      resolve({ code: code ?? 1, logPath, logText })
    })
  })

  return {
    child,
    logPath,
    slot,
    done,
    kill() {
      const pid = child.pid
      if (!pid) return
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
        return
      }
      try { child.kill('SIGTERM') } catch { /* already exited */ }
      const killer = setTimeout(() => {
        try { if (child.exitCode == null) child.kill('SIGKILL') } catch { /* already exited */ }
        try { spawnSync('pkill', ['-f', profileDir], { stdio: 'ignore' }) } catch { /* none */ }
      }, 2000)
      child.once('exit', () => clearTimeout(killer))
    },
  }
}
