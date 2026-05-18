import { put, list, get } from '@vercel/blob'

const PREFIX = 'forms/'

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN
}

/** slug for path segment: spaces → underscores; strip unsafe chars (keep Hebrew/Latin letters, digits, underscore) */
function slugSegment(str) {
  let s = String(str ?? '').trim()
  if (!s) return ''
  s = s.replace(/\s+/g, '_')
  s = s.replace(/[/\\?*:|"<>]/g, '')
  s = s.replace(/[^\w\u0590-\u05FF.-]/g, '_')
  return s.replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80)
}

/**
 * Readable path under forms/: forms/{first}_{last}_{formId}.json
 * formId = passportId_date (e.g. 1234455_2026-05-09) | incomplete
 */
function blobPathnameForPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {}
  const first = slugSegment(data.firstName) || 'unnamed'
  const last = slugSegment(data.lastName) || 'unnamed'
  const fidRaw =
    payload?.formId != null && String(payload.formId).trim() !== ''
      ? String(payload.formId).trim()
      : 'incomplete'
  return `${PREFIX}${first}_${last}_${fidRaw}.json`
}

/** Parse new-style filename; returns null if not matched */
function parseReadableFilename(inner) {
  if (inner.endsWith('_incomplete')) {
    const namePart = inner.slice(0, -'_incomplete'.length)
    return {
      displayName: namePart.replace(/_/g, ' ').trim() || 'ללא שם',
      formId: 'incomplete',
    }
  }

  const dateRe = /_(\d{4}-\d{2}-\d{2})$/
  const dm = inner.match(dateRe)
  if (!dm) return null

  const date = dm[1]
  const beforeDate = inner.slice(0, inner.length - dm[0].length)
  const pm = beforeDate.match(/^(.*)_([A-Za-z0-9]+)$/)
  if (!pm) return null

  const namePart = pm[1]
  const passport = pm[2]
  const formId = `${passport}_${date}`
  const displayName = namePart.replace(/_/g, ' ').trim() || 'ללא שם'
  return { displayName, formId }
}

/** Legacy: encodeURIComponent(fullName)__formId.json */
function parseLegacyFilename(inner) {
  const sep = '__'
  const idx = inner.indexOf(sep)
  if (idx === -1) return null
  const encodedName = inner.slice(0, idx)
  const formId = inner.slice(idx + sep.length)
  let displayName = encodedName
  try {
    displayName = decodeURIComponent(encodedName)
  } catch {
    /* keep */
  }
  return { displayName, formId }
}

function parseListEntry(pathname) {
  if (!pathname.startsWith(PREFIX) || !pathname.endsWith('.json')) {
    return { pathname, displayName: pathname, formId: '' }
  }
  const inner = pathname.slice(PREFIX.length, -'.json'.length)

  const readable = parseReadableFilename(inner)
  if (readable) {
    return { pathname, displayName: readable.displayName, formId: readable.formId }
  }

  const legacy = parseLegacyFilename(inner)
  if (legacy) {
    return { pathname, displayName: legacy.displayName, formId: legacy.formId }
  }

  return { pathname, displayName: inner.replace(/_/g, ' '), formId: '' }
}

async function readBodyJson(req) {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body
  }
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

async function streamToUtf8(stream) {
  const buf = await new Response(stream).arrayBuffer()
  return Buffer.from(buf).toString('utf8')
}

/** @param {import('http').IncomingMessage} req */
export default async function handler(req, res) {
  const token = blobToken()
  if (!token) {
    res.status(503).json({ error: 'Blob not configured', code: 'BLOB_DISABLED' })
    return
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      const rawPath = url.searchParams.get('pathname')
      if (rawPath) {
        let pathname = rawPath
        try {
          pathname = decodeURIComponent(rawPath)
        } catch {
          pathname = rawPath
        }

        const result = await get(pathname, { access: 'private', token })
        if (!result || result.statusCode !== 200 || !result.stream) {
          res.status(404).json({ error: 'Blob not found', pathname })
          return
        }
        const text = await streamToUtf8(result.stream)
        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          res.status(500).json({ error: 'Invalid JSON in blob' })
          return
        }
        res.status(200).json({ payload, pathname })
        return
      }

      const out = []
      let cursor
      let hasMore = true
      while (hasMore) {
        const page = await list({
          prefix: PREFIX,
          token,
          cursor,
          limit: 1000,
        })
        for (const b of page.blobs) {
          const parsed = parseListEntry(b.pathname)
          out.push({
            pathname: b.pathname,
            displayName: parsed.displayName,
            formId: parsed.formId,
            uploadedAt: b.uploadedAt?.toISOString?.() ?? null,
            size: b.size,
          })
        }
        hasMore = page.hasMore
        cursor = page.cursor
      }

      out.sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))
      res.status(200).json({ forms: out })
      return
    }

    if (req.method === 'POST') {
      const body = await readBodyJson(req)
      const { payload, pathname: pathnameOverride } = body
      if (!payload || typeof payload !== 'object') {
        res.status(400).json({ error: 'Missing payload' })
        return
      }
      // Use the client-supplied pathname (original blob key) when available so
      // re-saves always overwrite the same file regardless of any form data changes.
      const isValidOverride =
        typeof pathnameOverride === 'string' &&
        pathnameOverride.startsWith('forms/') &&
        pathnameOverride.endsWith('.json')
      const pathname = isValidOverride ? pathnameOverride : blobPathnameForPayload(payload)
      const json = JSON.stringify(payload)
      await put(pathname, json, {
        access: 'private',
        token,
        contentType: 'application/json',
        allowOverwrite: true,
      })
      res.status(200).json({ pathname, ok: true })
      return
    }

    res.setHeader('Allow', 'GET, POST')
    res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    console.error('[form-blob]', e)
    res.status(500).json({ error: e?.message || 'Blob error' })
  }
}
