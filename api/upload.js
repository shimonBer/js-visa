import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

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

/**
 * POST raw file body. Headers: X-Form-Id, X-File-Name; Content-Type = file MIME type.
 * Uploads with AWS credentials from env (never exposed to the browser).
 * Region: S3_REGION → AWS_S3_REGION → AWS_REGION → default. On Vercel, set S3_REGION to the bucket region.
 */
export default async function handler(req, res) {
  if (req.method === 'GET' && process.env.DEBUG_UPLOAD === '1') {
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

  const bucket = resolveBucket()
  const region = resolveS3Region()
  maybeLogAwsEnvSnapshot(bucket, region, accessKeyId, secretAccessKey)
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
    // SDK ≥3.729 enables CRC32 checksum headers on PutObject by default; that path can yield
    // SignatureDoesNotMatch with some runtimes. WHEN_REQUIRED restores classic SigV4-only PUTs.
    requestChecksumCalculation: 'WHEN_REQUIRED',
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
