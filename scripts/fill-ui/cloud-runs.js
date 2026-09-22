import fs from 'node:fs'

const RECORD_PREFIX = 'fill-runs/records/'
const SHOT_PREFIX = 'fill-runs/shots/'

export function fillRunRecordPath(id) {
  return `${RECORD_PREFIX}${id}.json`
}

export function fillRunShotPath(id) {
  return `${SHOT_PREFIX}${id}.jpg`
}

export async function publishFillRun(record, { token = process.env.BLOB_READ_WRITE_TOKEN, shotPath = '' } = {}) {
  const blobToken = String(token || '').trim()
  const id = String(record?.id || '').trim()
  if (!blobToken || !id) return { published: false }

  const { put } = await import('@vercel/blob')
  let shotStored = false
  if (shotPath && fs.existsSync(shotPath)) {
    const bytes = fs.readFileSync(shotPath)
    if (bytes.length > 0 && bytes.length <= 1_500_000) {
      await put(fillRunShotPath(id), bytes, {
        access: 'private',
        token: blobToken,
        contentType: 'image/jpeg',
        allowOverwrite: true,
      })
      shotStored = true
    }
  }

  const body = {
    id,
    name: record.name || '',
    ts: record.ts || new Date().toISOString(),
    startedAt: record.startedAt || record.ts || '',
    status: record.status || '',
    portalStatus: record.portalStatus || '',
    appId: record.appId || '',
    formId: record.formId || '',
    reason: record.reason || '',
    logExcerpt: record.logExcerpt || '',
    hasShot: shotStored || Boolean(record.hasShot),
  }
  await put(fillRunRecordPath(id), JSON.stringify(body), {
    access: 'private',
    token: blobToken,
    contentType: 'application/json',
    allowOverwrite: true,
  })
  return { published: true, hasShot: body.hasShot }
}
