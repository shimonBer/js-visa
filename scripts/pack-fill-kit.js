#!/usr/bin/env node
/**
 * Build a Desktop zip a worker can unzip, install, and run fill-ds160 from.
 *
 *   node scripts/pack-fill-kit.js
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.join(os.homedir(), 'Desktop')
const kitName = 'fill-ds160-kit'
const kitDir = path.join(desktop, kitName)
const zipPath = path.join(desktop, `${kitName}.zip`)

const FILL_ENV_KEYS = [
  'OPENAI_API_KEY',
  'TWOCAPTCHA_API_KEY',
  'S3_UPLOAD_API_URL',
  'VITE_S3_UPLOAD_API_URL',
  'S3_BUCKET',
  'S3_BUCKET_NAME',
  'S3_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DS160_FILL_EMAIL_TO',
  'DS160_FILL_EMAIL_FROM',
  'DS160_FILL_EMAIL_EVENTS',
  'RESEND_API_KEY',
  'DS160_FILL_WEBHOOK_URL',
]

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...opts })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim())
  }
  return result
}

function readDotenv(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const env = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[trimmed.slice(0, eq)] = value
  }
  return env
}

function writeFillEnv(dest, sourceEnv) {
  const lines = ['# fill-ds160 worker secrets — do not email or commit this file']
  for (const key of FILL_ENV_KEYS) {
    const value = sourceEnv[key]
    if (!value) continue
    lines.push(`${key}=${JSON.stringify(value)}`)
  }
  if (lines.length === 1) {
    lines.push('# No fill keys were found in the source .env. Add OPENAI_API_KEY before filling.')
  }
  fs.writeFileSync(dest, `${lines.join('\n')}\n`)
}

const readme = `fill-ds160 — worker kit
=======================

Mac
1. Unzip this folder.
2. Double-click: scripts/Install Fill DS-160 on Desktop.command
3. Desktop app: fill-ds160
4. Add translation files and press play on each. They run one after another.

Windows
0. Install Node 20 LTS (https://nodejs.org) and Google Chrome.
1. Unzip this folder. Keep it on the PC (do not run from the zip).
2. Double-click: scripts\Install-fill-ds160.bat
   First install needs internet (Node packages + Chromium fallback).
3. Desktop shortcut: fill-ds160
4. Same Hebrew window: add files, play / stop per file. Fills run one after another.

In the visa form, translate and download first_last.txt, then drop those files into fill-ds160.

Keep this folder private — it includes API keys in .env.
`

fs.rmSync(kitDir, { recursive: true, force: true })
fs.mkdirSync(kitDir, { recursive: true })

run('rsync', [
  '-a',
  '--delete',
  '--exclude', '.git',
  '--exclude', 'node_modules',
  '--exclude', 'graphify-out',
  '--exclude', 'autofill-output',
  '--exclude', 'people',
  '--exclude', 'dist',
  '--exclude', '.env',
  '--exclude', '.vercel',
  '--exclude', '.DS_Store',
  '--exclude', 'dom-snapshots/*.png',
  '--exclude', 'dom-snapshots/*.html',
  `${repoRoot}/`,
  `${kitDir}/`,
])

const batPath = path.join(kitDir, 'scripts', 'Install-fill-ds160.bat')
if (fs.existsSync(batPath)) {
  const crlf = fs.readFileSync(batPath, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  fs.writeFileSync(batPath, crlf)
}

writeFillEnv(path.join(kitDir, '.env'), {
  ...readDotenv(path.join(repoRoot, 'env.example')),
  ...readDotenv(path.join(repoRoot, '.env')),
})
fs.writeFileSync(path.join(kitDir, 'HOW-TO.txt'), readme)

if (fs.existsSync(zipPath)) fs.rmSync(zipPath)
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', kitDir, zipPath])

console.log(`Worker folder: ${kitDir}`)
console.log(`Worker zip:    ${zipPath}`)
console.log('Copy the zip to the worker computer, unzip, then run the Mac or Windows installer.')
