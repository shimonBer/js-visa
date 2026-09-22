import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  extractApplicationIdFromLog,
  lookupApplicationId,
  parseApplicationId,
  peekApplicationId,
  rememberApplicationId,
  forgetApplicationId,
  embeddedFormIdFromText,
} from '../../autofill/application-id-store.js'

export {
  extractApplicationIdFromLog,
  lookupApplicationId,
  parseApplicationId,
  peekApplicationId,
  rememberApplicationId,
  forgetApplicationId,
  embeddedFormIdFromText,
}

export const STATUS_HE = {
  idle: 'ממתין',
  queued: 'בתור',
  filling: 'ממלא',
  succeeded: 'הצליח',
  failed: 'נכשל',
  blocked: 'לבדיקה',
  stopped: 'נעצר',
}

export function extractFillReason(logText) {
  const text = String(logText || '')
  const patterns = [
    /Fatal error[^\n]*/i,
    /Stall detected[^\n]*/i,
    /Autofill failed[^\n]*/i,
    /Chrome\/Cloudflare[^\n]*/i,
    /CEAC[^\n]*/i,
    /OPENAI_API_KEY is not set[^\n]*/i,
    /Applicant form UUID is missing[^\n]*/i,
    /Input file[^\n]*/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[0].replace(/\s+/g, ' ').trim()
  }
  const errorLine = [...text.split('\n')].reverse().find((line) => /error|failed|❌/i.test(line))
  return errorLine?.replace(/\s+/g, ' ').trim() || ''
}

export function classifyFillResult({ code, logText, stopped } = {}) {
  if (stopped) return { status: 'stopped', reason: 'stopped', appId: extractApplicationIdFromLog(logText) }
  const text = String(logText || '')
  const appId = extractApplicationIdFromLog(text)
  if (
    /APPLICATION SUBMITTED/i.test(text)
    || /APPLICATION_ALREADY_SUBMITTED/i.test(text)
    || /already submitted at CEAC/i.test(text)
  ) {
    return { status: 'succeeded', reason: 'submitted', appId }
  }
  if (/stopped at the submission boundary/i.test(text) || /stopped before submit/i.test(text)) {
    return { status: 'blocked', reason: 'needs_review', appId }
  }
  return {
    status: 'failed',
    reason: extractFillReason(text) || (code ? `exit ${code}` : 'incomplete'),
    appId,
  }
}

export function eventsPath(repoRoot) {
  return path.join(repoRoot, 'autofill-output', 'fill-events.jsonl')
}

export function appendFillEvent(repoRoot, event) {
  const file = eventsPath(repoRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`)
}

export function notifyFillEvent({ title = 'fill-ds160', message, sound = false }) {
  const text = String(message || '').slice(0, 180)
  try {
    if (process.platform === 'darwin') {
      const soundClause = sound ? ' sound name "Basso"' : ''
      spawn('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}${soundClause}`], {
        stdio: 'ignore',
        detached: true,
      }).unref()
      return
    }
    if (process.platform === 'win32') {
      const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(5000, ${JSON.stringify(title)}, ${JSON.stringify(text)}, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 6
$n.Dispose()
`
      spawn('powershell', ['-NoProfile', '-Command', script], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }).unref()
    }
  } catch {
    /* notification is best-effort */
  }
}

export async function postFillWebhook(event) {
  const url = String(process.env.DS160_FILL_WEBHOOK_URL || '').trim()
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
  } catch {
    /* webhook is optional */
  }
}

export function notifyCopy(status, name, reason = '') {
  const label = STATUS_HE[status] || status
  const base = `${label}: ${name}`
  if ((status === 'failed' || status === 'blocked') && reason) {
    return `${base} — ${reason}`.slice(0, 180)
  }
  return base
}

export function chromeProfileDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/DS160-Fill-Chrome')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DS160-Fill-Chrome')
  }
  return path.join(os.homedir(), '.ds160-fill-chrome')
}

export function chromeProfileDirForSlot(slot = 1) {
  const n = Number(slot) === 2 ? 2 : 1
  return path.join(chromeProfileDir(), `slot-${n}`)
}
