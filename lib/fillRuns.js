import { get, list } from '@vercel/blob'

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function portalStatus(status) {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'blocked') return 'fail'
  if (status === 'stopped') return 'stopped'
  return 'pending'
}

function shotPath(id) {
  return `fill-runs/shots/${id}.jpg`
}

async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function readRecord(token, pathname) {
  const result = await get(pathname, { access: 'private', token })
  if (!result || result.statusCode !== 200 || !result.stream) return null
  const text = (await streamToBuffer(result.stream)).toString('utf8')
  const record = JSON.parse(text)
  if (!record || typeof record !== 'object') return null
  return {
    ...record,
    portalStatus: record.portalStatus || portalStatus(record.status),
  }
}

/** Served from /api/form-blob so the portal stays within the Hobby function limit. */
export async function serveFillRunRequest(res, token, url) {
  const wantsList = url.searchParams.get('fillRuns') === '1'
  const shotId = String(url.searchParams.get('fillShot') || '')
  if (!wantsList && !shotId) return false

  if (shotId) {
    if (!RUN_ID.test(shotId)) {
      res.status(400).json({ error: 'Invalid run id' })
      return true
    }
    try {
      const result = await get(shotPath(shotId), { access: 'private', token })
      if (!result || result.statusCode !== 200 || !result.stream) {
        res.status(404).json({ error: 'Screenshot not found' })
        return true
      }
      const bytes = await streamToBuffer(result.stream)
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.status(200).end(bytes)
    } catch (err) {
      console.error('[fill-runs] shot', err)
      res.status(500).json({ error: 'Could not load screenshot' })
    }
    return true
  }

  try {
    const blobs = []
    let cursor
    let hasMore = true
    while (hasMore && blobs.length < 400) {
      const page = await list({ prefix: 'fill-runs/records/', token, cursor, limit: 1000 })
      blobs.push(...page.blobs)
      hasMore = page.hasMore
      cursor = page.cursor
    }
    blobs.sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))
    const newest = blobs.slice(0, 120)
    const runs = []
    for (let i = 0; i < newest.length; i += 20) {
      const chunk = newest.slice(i, i + 20)
      const loaded = await Promise.all(chunk.map(async (blob) => {
        try {
          if (!blob.pathname) return null
          return await readRecord(token, blob.pathname)
        } catch {
          return null
        }
      }))
      for (const record of loaded) {
        if (record?.id) runs.push(record)
      }
    }
    runs.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    res.status(200).json({ runs })
  } catch (err) {
    console.error('[fill-runs]', err)
    res.status(500).json({ error: err?.message || 'Could not list runs' })
  }
  return true
}
