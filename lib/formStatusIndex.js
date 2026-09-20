import { get, list, put } from '@vercel/blob'
import { pathnameMatchesFormId } from './ds160SubmittedPdfs.js'

export const FORM_STATUS_PATH = 'forms-meta/status.json'
const FORM_PREFIX = 'forms/'

async function streamToUtf8(stream) {
  const buf = await new Response(stream).arrayBuffer()
  return Buffer.from(buf).toString('utf8')
}

export async function readStatusIndex(token) {
  try {
    const result = await get(FORM_STATUS_PATH, { access: 'private', token })
    if (!result || result.statusCode !== 200 || !result.stream) return {}
    return JSON.parse(await streamToUtf8(result.stream))
  } catch {
    return {}
  }
}

export async function writeStatusIndex(token, index) {
  await put(FORM_STATUS_PATH, JSON.stringify(index), {
    access: 'private',
    token,
    contentType: 'application/json',
    allowOverwrite: true,
  })
}

async function findFormPathname(token, formId, index) {
  const fromIndex = Object.keys(index).find((pathname) => pathnameMatchesFormId(pathname, formId))
  if (fromIndex) return fromIndex
  let cursor
  let hasMore = true
  while (hasMore) {
    const page = await list({ prefix: FORM_PREFIX, token, cursor, limit: 1000 })
    const match = page.blobs.find((blob) => pathnameMatchesFormId(blob.pathname, formId))
    if (match) return match.pathname
    hasMore = page.hasMore
    cursor = page.cursor
  }
  return null
}

/** Stamp portal status when CEAC confirmation/application PDFs land in S3. */
export async function stampDs160FilledAt(formId) {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  const id = String(formId || '').trim()
  if (!token || !id) return false
  const index = await readStatusIndex(token)
  const pathname = await findFormPathname(token, id, index)
  if (!pathname) return false
  const prev = index[pathname] || {}
  if (prev.ds160FilledAt) return false
  index[pathname] = { ...prev, ds160FilledAt: new Date().toISOString() }
  await writeStatusIndex(token, index)
  return true
}
