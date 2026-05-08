import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const DEFAULT_BUCKET = 'js_visa'
const PRESIGN_TTL_SECONDS = 900

/** @param {import('http').IncomingMessage} req */
async function readJsonBody(req) {
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
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

function sanitizeFormId(formId) {
  const s = String(formId ?? '').trim().slice(0, 120)
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null
  return s
}

function sanitizeFileName(fileName) {
  const base = String(fileName ?? '')
    .trim()
    .replace(/[/\\]/g, '')
    .slice(0, 180)
  if (!base || base.includes('..')) return null
  return base
}

function sanitizeContentType(ct) {
  const s = String(ct || 'application/octet-stream').trim().slice(0, 120)
  if (!/^[\w./+-]+$/.test(s)) return 'application/octet-stream'
  return s
}

function s3DisabledResponse(res) {
  res.status(503).json({
    error: 'S3 upload not configured',
    code: 'S3_DISABLED',
  })
}

/**
 * POST JSON { formId, fileName, contentType } → { url, key, bucket }
 * AWS credentials from env only (set in Vercel; never VITE_*).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    s3DisabledResponse(res)
    return
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  const formId = sanitizeFormId(body.formId)
  const fileName = sanitizeFileName(body.fileName)
  const contentType = sanitizeContentType(body.contentType)

  if (!formId || !fileName) {
    res.status(400).json({ error: 'Invalid formId or fileName' })
    return
  }

  const bucket = (process.env.S3_BUCKET || DEFAULT_BUCKET).trim() || DEFAULT_BUCKET
  const region = (process.env.AWS_REGION || 'eu-west-1').trim() || 'eu-west-1'

  const key = `${formId}/${fileName}`
  if (key.length > 900) {
    res.status(400).json({ error: 'Key too long' })
    return
  }

  const client = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(process.env.AWS_SESSION_TOKEN && {
        sessionToken: process.env.AWS_SESSION_TOKEN,
      }),
    },
  })

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  })

  try {
    const url = await getSignedUrl(client, command, {
      expiresIn: PRESIGN_TTL_SECONDS,
    })
    res.status(200).json({ url, key, bucket })
  } catch (e) {
    console.error('[presign]', e)
    res.status(500).json({
      error: 'Could not create upload URL',
      code: 'PRESIGN_FAILED',
    })
  }
}
