import { put, list, get } from '@vercel/blob'

const PREFIX = 'forms/'

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN
}

/** @param {Record<string, unknown>} data form values */
function fullNameFromPayloadData(data) {
  const fn = String(data?.firstName ?? '').trim()
  const ln = String(data?.lastName ?? '').trim()
  const joined = [fn, ln].filter(Boolean).join(' ')
  return joined || 'ללא שם'
}

/**
 * Path: forms/{encodeURIComponent(fullName)}__{formId}.json
 * formId = passport_date | incomplete
 */
function blobPathnameForPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {}
  const fullName = fullNameFromPayloadData(data)
  const fidRaw = payload?.formId != null && String(payload.formId).trim() !== ''
    ? String(payload.formId).trim()
    : 'incomplete'
  const encoded = encodeURIComponent(fullName)
  return `${PREFIX}${encoded}__${fidRaw}.json`
}

function parseListEntry(pathname) {
  if (!pathname.startsWith(PREFIX) || !pathname.endsWith('.json')) {
    return { pathname, displayName: pathname, formId: '' }
  }
  const inner = pathname.slice(PREFIX.length, -'.json'.length)
  const sep = '__'
  const idx = inner.indexOf(sep)
  if (idx === -1) {
    return { pathname, displayName: inner, formId: '' }
  }
  const encodedName = inner.slice(0, idx)
  const formId = inner.slice(idx + sep.length)
  let displayName = encodedName
  try {
    displayName = decodeURIComponent(encodedName)
  } catch {
    /* keep encoded */
  }
  return { pathname, displayName, formId }
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
      const pathname = url.searchParams.get('pathname')

      if (pathname) {
        const result = await get(pathname, { access: 'private', token })
        if (!result || result.statusCode !== 200 || !result.stream) {
          res.status(404).json({ error: 'Blob not found' })
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
      const { payload } = await readBodyJson(req)
      if (!payload || typeof payload !== 'object') {
        res.status(400).json({ error: 'Missing payload' })
        return
      }
      const pathname = blobPathnameForPayload(payload)
      const json = JSON.stringify(payload)
      await put(pathname, json, {
        access: 'private',
        token,
        contentType: 'application/json',
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
