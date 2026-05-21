/**
 * POST /api/delete-form
 * Body: JSON { pathname: string } — must be a `forms/*.json` Vercel Blob path.
 * Loads the blob JSON, deletes referenced S3 objects, then deletes the blob.
 */

import { get, del } from '@vercel/blob'
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { verifyRequest } from './lib/verifyToken.js'

const PREFIX = 'forms/'

const DEFAULT_BUCKET = 'js_visa'
const DEFAULT_REGION = 'eu-north-1'

function resolveBucket() {
  const fromEnv = process.env.S3_BUCKET?.trim() || process.env.S3_BUCKET_NAME?.trim()
  return fromEnv || DEFAULT_BUCKET
}

function resolveS3Region() {
  const explicit =
    process.env.S3_REGION?.trim() ||
    process.env.AWS_S3_REGION?.trim() ||
    process.env.AWS_REGION?.trim()
  return explicit || DEFAULT_REGION
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN
}

/** Same rules as api/upload.js — only delete keys that pass this gate. */
function sanitizeFormId(formId) {
  const s = String(formId ?? '').trim().slice(0, 120)
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null
  return s
}

function sanitizeS3ObjectKey(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s.length > 920 || s.includes('..')) return null
  const slash = s.indexOf('/')
  if (slash < 1) return null
  const formId = sanitizeFormId(s.slice(0, slash))
  const rest = s.slice(slash + 1)
  if (!formId || !rest || rest.includes('/')) return null
  if (!/^[a-zA-Z0-9_.-]+$/.test(rest) || rest.length > 200) return null
  return `${formId}/${rest}`
}

function isAllowedBlobPathname(pathname) {
  if (typeof pathname !== 'string') return false
  if (pathname.length > 500 || pathname.includes('..')) return false
  if (!pathname.startsWith(PREFIX) || !pathname.endsWith('.json')) return false
  return true
}

/** @param {import('http').IncomingMessage} req */
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

function makeS3Client(accessKeyId, secretAccessKey, sessionToken) {
  const region = resolveS3Region()
  return new S3Client({
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken && { sessionToken }),
    },
  })
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const authResult = verifyRequest(req)
  if (!authResult.ok) {
    return res.status(authResult.status).json({ error: authResult.error })
  }

  const token = blobToken()
  if (!token) {
    return res.status(503).json({ error: 'Blob not configured', code: 'BLOB_DISABLED' })
  }

  let body
  try {
    body = await readBodyJson(req)
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }

  const pathname = typeof body.pathname === 'string' ? body.pathname.trim() : ''
  if (!isAllowedBlobPathname(pathname)) {
    return res.status(400).json({ error: 'Invalid pathname (expected forms/… .json)' })
  }

  try {
    const result = await get(pathname, { access: 'private', token })
    if (!result || result.statusCode !== 200 || !result.stream) {
      return res.status(404).json({ error: 'Blob not found', pathname })
    }

    const text = await streamToUtf8(result.stream)
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return res.status(500).json({ error: 'Invalid JSON in blob' })
    }

    const s3Deleted = []
    const s3Errors = []

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
    const sessionToken = process.env.AWS_SESSION_TOKEN?.trim()

    if (accessKeyId && secretAccessKey) {
      const bucket = resolveBucket()
      const client = makeS3Client(accessKeyId, secretAccessKey, sessionToken)
      const docs = Array.isArray(payload?.s3Documents) ? payload.s3Documents : []

      for (const doc of docs) {
        const rawKey = doc && typeof doc.key === 'string' ? doc.key : ''
        const key = sanitizeS3ObjectKey(rawKey)
        if (!key) {
          if (rawKey) s3Errors.push({ key: rawKey, error: 'Invalid S3 key in payload' })
          continue
        }
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          s3Deleted.push(key)
        } catch (e) {
          const code = e?.name || e?.Code || 'DeleteFailed'
          s3Errors.push({ key, error: String(e?.message || code) })
          console.error('[delete-form] DeleteObject', key, e)
        }
      }
    } else if (Array.isArray(payload?.s3Documents) && payload.s3Documents.length > 0) {
      return res.status(503).json({
        error: 'S3 not configured; cannot delete uploaded files. Blob was not removed.',
        code: 'S3_DISABLED',
      })
    }

    await del(pathname, { token })

    return res.status(200).json({
      ok: true,
      pathname,
      s3Deleted,
      s3Errors,
    })
  } catch (e) {
    console.error('[delete-form]', e)
    return res.status(500).json({ error: e?.message || 'Delete failed' })
  }
}
