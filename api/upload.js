import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const DEFAULT_BUCKET = 'js_visa'
const DEFAULT_REGION = 'eu-north-1'

/**
 * Vercel injects AWS_REGION = the *deployment* region (see Vercel KB “AWS SDK environment variables”).
 * That is often NOT your S3 bucket region → SignatureDoesNotMatch. Prefer S3_REGION for the bucket.
 */
function resolveBucket() {
  const fromEnv =
    process.env.S3_BUCKET?.trim() || process.env.S3_BUCKET_NAME?.trim()
  return fromEnv || DEFAULT_BUCKET
}

function resolveS3Region() {
  const explicit =
    process.env.S3_REGION?.trim() ||
    process.env.AWS_S3_REGION?.trim() ||
    process.env.AWS_REGION?.trim()
  return explicit || DEFAULT_REGION
}

/** Logged once per serverless instance on first upload. No secret values (lengths only). */
let awsEnvSnapshotLogged = false

function maybeLogAwsEnvSnapshot(bucket, region, accessKeyId, secretAccessKey) {
  if (awsEnvSnapshotLogged) return
  awsEnvSnapshotLogged = true
  console.log('[upload] aws env snapshot (sanitized)', {
    regionResolved: region,
    bucketResolved: bucket,
    S3_REGION: process.env.S3_REGION ?? null,
    AWS_S3_REGION: process.env.AWS_S3_REGION ?? null,
    AWS_REGION: process.env.AWS_REGION ?? null,
    S3_BUCKET: process.env.S3_BUCKET ?? null,
    S3_BUCKET_NAME: process.env.S3_BUCKET_NAME ?? null,
    VERCEL: process.env.VERCEL ?? null,
    hasAccessKeyId: !!accessKeyId,
    hasSecretAccessKey: !!secretAccessKey,
    accessKeyIdLen: accessKeyId?.length ?? 0,
    secretAccessKeyLen: secretAccessKey?.length ?? 0,
    hasSessionToken: !!process.env.AWS_SESSION_TOKEN?.trim(),
    requestChecksumCalculation: 'WHEN_REQUIRED',
  })
}

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

/** S3 object key from ?key=formId/fileName (must match upload layout). */
function sanitizeS3ObjectKeyFromQuery(raw) {
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

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024

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
 * POST raw file body. Headers: X-Form-Id, X-File-Name; Content-Type = file MIME type.
 * GET ?key=formId/fileName — download same object (for restoring drafts).
 * Uploads with AWS credentials from env (never exposed to the browser).
 * Region: S3_REGION → AWS_S3_REGION → AWS_REGION → default. On Vercel, set S3_REGION to the bucket region.
 */
export default async function handler(req, res) {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim()

  if (req.method === 'GET') {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const rawKeyParam = url.searchParams.get('key')
    const wantsDownload = rawKeyParam != null && String(rawKeyParam).trim() !== ''

    if (wantsDownload) {
      if (!accessKeyId || !secretAccessKey) {
        res.status(503).json({
          error: 'S3 upload not configured',
          code: 'S3_DISABLED',
        })
        return
      }
      let rawKey = rawKeyParam
      try {
        rawKey = decodeURIComponent(String(rawKeyParam))
      } catch {
        rawKey = rawKeyParam
      }
      const key = sanitizeS3ObjectKeyFromQuery(rawKey)
      if (!key) {
        res.status(400).json({ error: 'Invalid key' })
        return
      }

      const bucket = resolveBucket()
      maybeLogAwsEnvSnapshot(bucket, resolveS3Region(), accessKeyId, secretAccessKey)
      const client = makeS3Client(accessKeyId, secretAccessKey, sessionToken)

      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const stream = out.Body
        if (!stream) {
          res.status(404).json({ error: 'Not found' })
          return
        }
        const chunks = []
        let total = 0
        for await (const chunk of stream) {
          total += chunk.length
          if (total > MAX_DOWNLOAD_BYTES) {
            res.status(413).json({ error: 'File too large' })
            return
          }
          chunks.push(chunk)
        }
        const buf = Buffer.concat(chunks)
        const ctRaw = out.ContentType ? String(out.ContentType).trim() : ''
        const ct = sanitizeContentType(ctRaw)
        res.setHeader('Content-Type', ct)
        res.setHeader('Cache-Control', 'private, no-store')
        res.status(200).send(buf)
      } catch (e) {
        const status = e?.$metadata?.httpStatusCode
        const code = e?.name || e?.Code
        if (status === 404 || code === 'NoSuchKey') {
          res.status(404).json({ error: 'Not found' })
          return
        }
        console.error('[upload] GetObject', e)
        res.status(500).json({
          error: 'S3 download failed',
          code: 'DOWNLOAD_FAILED',
        })
      }
      return
    }

    if (process.env.DEBUG_UPLOAD === '1') {
      const bucket = resolveBucket()
      const region = resolveS3Region()
      res.status(200).json({
        vercel: process.env.VERCEL === '1',
        regionUsed: region,
        bucket,
        envAwsRegion: process.env.AWS_REGION ?? null,
        hasAccessKeyId: !!process.env.AWS_ACCESS_KEY_ID?.trim(),
        hasSecretAccessKey: !!process.env.AWS_SECRET_ACCESS_KEY?.trim(),
        requestChecksumCalculation: 'WHEN_REQUIRED',
        hint:
          'Set S3_REGION to your bucket region. On Vercel, AWS_REGION defaults to the deployment region unless you override it for Production.',
      })
      return
    }

    res.setHeader('Allow', 'GET, POST')
    res.status(400).json({
      error: 'Missing or invalid key query parameter (use ?key=formId/fileName, or DEBUG_UPLOAD=1 for diagnostics)',
    })
    return
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

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

  const bucket = resolveBucket()
  maybeLogAwsEnvSnapshot(bucket, resolveS3Region(), accessKeyId, secretAccessKey)
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

  const client = makeS3Client(accessKeyId, secretAccessKey, sessionToken)

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
