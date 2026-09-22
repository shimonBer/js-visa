import fs from 'node:fs'

import { eventsPath } from './status.js'

export function portalStatus(status) {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'blocked') return 'fail'
  if (status === 'stopped') return 'stopped'
  return 'pending'
}

const OPEN_STATUSES = new Set(['idle', 'queued', 'filling'])
const RAN_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'stopped'])

export function fileStem(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*\(\d+\)(?=\.txt$)/i, '')
    .replace(/_auto_fill(?=\.txt$)/i, '')
    .replace(/\.txt$/i, '')
    .trim()
}

export function isAutofillSourceName(name) {
  const base = String(name || '')
  return /_auto_fill/i.test(base) && /\.txt$/i.test(base)
}

/** A download that is still waiting and checked starts without another click. */
export function shouldAutoPlayDownload(item) {
  return Boolean(item?.id) && item.status === 'idle' && item.selected !== false
}

/** A file that already ran stays out of the batch until someone checks it. */
export function intakeForPrior(prior) {
  if (prior && RAN_STATUSES.has(prior.status)) {
    return { status: prior.status, selected: false }
  }
  return { status: 'idle', selected: true }
}

export function isTodoItem(item) {
  return OPEN_STATUSES.has(item?.status)
}

export function sectionId(item) {
  if (isTodoItem(item)) return 'todo'
  return RAN_STATUSES.has(item?.status) ? item.status : 'todo'
}

/** A fill that was running when the window closed is waiting again, still checked. */
export function reviveQueueItem(item) {
  if (!item?.path || !item?.name) return null
  let status = item.status || 'idle'
  let selected = item.selected !== false
  if (status === 'filling' || status === 'queued') status = 'idle'
  if (!OPEN_STATUSES.has(status) && !RAN_STATUSES.has(status)) status = 'idle'
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    status,
    selected,
    formId: item.formId || '',
    appId: item.appId || '',
    error: item.error || '',
    runId: item.runId || '',
    startedAt: item.startedAt || '',
    shotFile: item.shotFile || '',
  }
}

/** Checked means "include in the next run". A finished success leaves the batch. */
export function selectionAfterStatus(status, wasSelected = true) {
  if (status === 'succeeded') return false
  if (status === 'filling' || status === 'queued') return true
  return wasSelected !== false
}

export function extractRunScreenshot(logText) {
  const match = String(logText || '').match(/RUN_SCREENSHOT:\s*(\S+)/)
  return match ? match[1] : ''
}

export function readFillEvents(repoRoot) {
  const file = eventsPath(repoRoot)
  if (!fs.existsSync(file)) return []
  const events = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* skip a torn line */
    }
  }
  return events
}

export function groupFillRuns(events) {
  const byId = new Map()
  for (const event of events || []) {
    const id = String(event?.runId || event?.ts || '')
    if (!id) continue
    const prev = byId.get(id)
    const status = event.status || prev?.status || 'pending'
    const next = {
      id,
      name: event.name || prev?.name || '',
      ts: event.ts || prev?.ts || '',
      startedAt: prev?.startedAt || event.ts || '',
      status,
      portalStatus: portalStatus(status),
      appId: event.appId || prev?.appId || '',
      formId: event.formId || prev?.formId || '',
      reason: event.reason || (status === 'filling' ? prev?.reason : '') || prev?.reason || '',
      logExcerpt: event.logExcerpt || prev?.logExcerpt || '',
      shotFile: event.shotFile || prev?.shotFile || '',
    }
    byId.set(id, next)
  }
  return [...byId.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
}
