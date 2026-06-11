/**
 * Fetch uploaded form documents from S3 (same key layout as /api/upload).
 * Used by translate-form when the browser has metadata but no File blobs.
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

const DEFAULT_BUCKET = 'js_visa'
const DEFAULT_REGION = 'eu-north-1'
const MAX_BYTES = 4 * 1024 * 1024

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

function sanitizeFormId(formId) {
  const s = String(formId ?? '').trim().slice(0, 120)
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null
  return s
}

/** Same rules as api/upload.js `sanitizeS3ObjectKeyFromQuery` */
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

function sanitizeContentType(ct) {
  const s = String(ct || 'application/octet-stream').trim().slice(0, 120)
  if (!/^[\w./+-]+$/.test(s)) return 'application/octet-stream'
  return s
}

/**
 * @param {string} keyRaw — e.g. `1234455_2026-05-09/passportScan.jpg`
 * @returns {Promise<{ bytes: Uint8Array, contentType: string, fileName: string } | null>}
 */
export async function fetchS3FormDocumentBytes(keyRaw) {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim()
  if (!accessKeyId || !secretAccessKey) return null

  const key = sanitizeS3ObjectKey(keyRaw)
  if (!key) return null

  const bucket = resolveBucket()
  const client = makeS3Client(accessKeyId, secretAccessKey, sessionToken)

  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const stream = out.Body
    if (!stream) return null
    const chunks = []
    let total = 0
    for await (const chunk of stream) {
      total += chunk.length
      if (total > MAX_BYTES) return null
      chunks.push(chunk)
    }
    const buf = Buffer.concat(chunks)
    const ctRaw = out.ContentType ? String(out.ContentType).trim() : ''
    const contentType = sanitizeContentType(ctRaw).split(';')[0].trim().toLowerCase()
    const fileName = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    return {
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      contentType,
      fileName: fileName || 'document.bin',
    }
  } catch (e) {
    console.warn('[s3FormDocuments] GetObject failed', key, e?.name || e)
    return null
  }
}
