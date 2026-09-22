import os from 'node:os'
import { spawn } from 'node:child_process'

import { STATUS_HE, extractFillReason } from './status.js'

export function parseEmailList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.includes('@'))
}

export function logExcerpt(logText, maxLines = 20) {
  const lines = String(logText || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
  return lines.slice(-maxLines).join('\n').slice(0, 2500)
}

export function shouldEmailStatus(status, eventsEnv = process.env.DS160_FILL_EMAIL_EVENTS) {
  const raw = String(eventsEnv || 'start,end,fail').toLowerCase()
  const wanted = new Set(raw.split(/[,;\s]+/).filter(Boolean))
  const map = {
    filling: 'start',
    succeeded: 'end',
    blocked: 'end',
    stopped: 'end',
    failed: 'fail',
  }
  return wanted.has(map[status] || '')
}

export function buildFillEmail(event) {
  const status = event.status || ''
  const label = STATUS_HE[status] || status
  const name = event.name || 'unknown'
  const reason = event.reason || extractFillReason(event.logText) || ''
  const subject = `fill-ds160 · ${label} · ${name}`
  const lines = [
    `Status: ${label} (${status})`,
    `File: ${name}`,
    event.appId ? `Application ID: ${event.appId}` : '',
    reason ? `Reason: ${reason}` : '',
    event.host ? `Computer: ${event.host}` : '',
    event.path ? `Path: ${event.path}` : '',
    event.ts ? `Time: ${event.ts}` : `Time: ${new Date().toISOString()}`,
  ].filter(Boolean)
  const excerpt = event.logExcerpt || logExcerpt(event.logText)
  const text = excerpt
    ? `${lines.join('\n')}\n\n--- last log lines ---\n${excerpt}\n`
    : `${lines.join('\n')}\n`
  return { subject, text }
}

async function sendResend({ apiKey, from, to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`)
  }
}

function sendMacMail({ to, subject, text }) {
  const recipients = to
    .map((address) => `make new to recipient at end of to recipients with properties {address:${JSON.stringify(address)}}`)
    .join('\n    ')
  const script = `
tell application "Mail"
  set theMessage to make new outgoing message with properties {subject:${JSON.stringify(subject)}, content:${JSON.stringify(text)}, visible:false}
  tell theMessage
    ${recipients}
    send
  end tell
end tell
`
  const child = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true })
  child.unref()
}

export async function emailFillEvent(event) {
  if (!shouldEmailStatus(event.status)) return
  const to = parseEmailList(process.env.DS160_FILL_EMAIL_TO)
  if (!to.length) return
  const payload = {
    ...event,
    host: event.host || os.hostname(),
    ts: event.ts || new Date().toISOString(),
  }
  const { subject, text } = buildFillEmail(payload)
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = process.env.DS160_FILL_EMAIL_FROM?.trim() || 'fill-ds160 <onboarding@resend.dev>'
  if (apiKey) {
    await sendResend({ apiKey, from, to, subject, text })
    return
  }
  if (process.platform === 'darwin') {
    sendMacMail({ to, subject, text })
  }
}
