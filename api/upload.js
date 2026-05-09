import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const DEFAULT_BUCKET = 'js_visa'
const DEFAULT_REGION = 'eu-north-1'

/** @param {import('http').IncomingMessage} req */
async function readBodyBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
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

/**
 * POST raw file body. Headers: X-Form-Id, X-File-Name; Content-Type = file MIME type.
 * Uploads with AWS credentials from env (never exposed to the browser).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Trim: pasted keys in hosting dashboards often include a trailing newline → SignatureDoesNotMatch
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim()
  if (!accessKeyId || !secretAccessKey) {
    res.status(503).json({
      error: 'S3 upload not configured',
      code: 'S3_DISABLED',
    })
    return
  }

  const formId = sanitizeFormId(req.headers['x-form-id'])
  const fileName = sanitizeFileName(req.headers['x-file-name'])
  const contentType = sanitizeContentType(req.headers['content-type'])

  if (!formId || !fileName) {
    res.status(400).json({ error: 'Missing or invalid X-Form-Id / X-File-Name' })
    return
  }

  const bucket = (process.env.S3_BUCKET || DEFAULT_BUCKET).trim() || DEFAULT_BUCKET
  const region = (process.env.AWS_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION
  const key = `${formId}/${fileName}`
  if (key.length > 900) {
    res.status(400).json({ error: 'Key too long' })
    return
  }

  let body
  try {
    body = await readBodyBuffer(req)
  } catch (e) {
    console.error('[upload] body read', e)
    res.status(400).json({ error: 'Could not read body' })
    return
  }

  if (!body?.length) {
    res.status(400).json({ error: 'Empty body' })
    return
  }

  const client = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken && { sessionToken }),
    },
  })

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    )
    res.status(200).json({ key, bucket })
  } catch (e) {
    console.error('[upload] PutObject', e)
    res.status(500).json({
      error: 'S3 upload failed',
      code: 'UPLOAD_FAILED',
    })
  }
}
