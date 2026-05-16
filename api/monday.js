/**
 * POST /api/monday
 * Creates a Monday.com board item and uploads the DS-160 translation PDF to a Files column.
 *
 * Body (JSON):
 *   { applicantName: string, pdfBase64: string, status?: string, metadata?: object }
 *
 * Response:
 *   { success: true, itemId: string, fileUpload: object }
 *   { success: false, error: string, code?: string, itemId?: string }
 *
 * Env (server only, set in Vercel — never VITE_*):
 *   MONDAY_API_TOKEN, MONDAY_BOARD_ID, MONDAY_FILE_COLUMN_ID
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const MONDAY_GRAPHQL_URL = 'https://api.monday.com/v2'
const MONDAY_FILE_URL = 'https://api.monday.com/v2/file'

/** Max PDF size after base64 decode (25 MB) */
const MAX_PDF_BYTES = 25 * 1024 * 1024

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readBodyJson(req) {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    return /** @type {Record<string, unknown>} */ (req.body)
  }
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Invalid JSON body')
  }
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function jsonResponse(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * @param {unknown} json
 * @returns {string[]}
 */
function graphqlErrorMessages(json) {
  if (!json || typeof json !== 'object') return []
  const errors = /** @type {{ message?: string }[]} */ (/** @type {Record<string, unknown>} */ (json).errors)
  if (!Array.isArray(errors)) return []
  return errors.map((e) => (typeof e?.message === 'string' ? e.message : 'Unknown GraphQL error')).filter(Boolean)
}

/**
 * Run a GraphQL operation against Monday `POST /v2` (JSON body).
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.query
 * @param {Record<string, unknown>} [opts.variables]
 * @returns {Promise<Record<string, unknown>>}
 */
async function mondayGraphqlRequest({ apiToken, query, variables = {} }) {
  const res = await fetch(MONDAY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiToken,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  })

  const raw = await res.text()
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`Monday API returned non-JSON (${res.status}): ${raw.slice(0, 200)}`)
  }

  if (!res.ok) {
    const msgs = graphqlErrorMessages(json)
    throw new Error(
      msgs.length ? `Monday HTTP ${res.status}: ${msgs.join('; ')}` : `Monday HTTP ${res.status}: ${raw.slice(0, 300)}`,
    )
  }

  const msgs = graphqlErrorMessages(json)
  if (msgs.length) {
    throw new Error(`Monday GraphQL: ${msgs.join('; ')}`)
  }

  if (!json || typeof json !== 'object' || !('data' in json)) {
    throw new Error('Monday API response missing data')
  }

  return /** @type {Record<string, unknown>} */ (json)
}

/**
 * Create a board item (pulse) with the given display name.
 * Optional `status` is appended to the item name for boards without a dedicated status column env.
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.boardId
 * @param {string} opts.applicantName
 * @param {string} [opts.status]
 * @returns {Promise<string>} New item id
 */
export async function createMondayItem({ apiToken, boardId, applicantName, status }) {
  const name = String(applicantName || '').trim()
  if (!name) {
    throw new Error('createMondayItem: applicantName is required')
  }
  const itemName =
    status != null && String(status).trim() !== '' ? `${name} — ${String(status).trim()}` : name

  const query = `
    mutation CreateItem($boardId: ID!, $itemName: String!) {
      create_item(board_id: $boardId, item_name: $itemName) {
        id
        name
      }
    }
  `

  const json = await mondayGraphqlRequest({
    apiToken,
    query,
    variables: {
      boardId: String(boardId),
      itemName: itemName.slice(0, 255),
    },
  })

  const data = /** @type {Record<string, unknown>} */ (json.data)
  const createItem = /** @type {{ id?: string } | null | undefined} */ (data?.create_item)
  const id = createItem?.id
  if (!id || typeof id !== 'string') {
    throw new Error('createMondayItem: missing create_item.id in Monday response')
  }
  return id
}

/**
 * Upload a PDF to a Files column via `POST /v2/file` (multipart/form-data).
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.itemId
 * @param {string} opts.fileColumnId — column id (e.g. "files" or board-specific id)
 * @param {string} opts.filePath — absolute path to PDF on disk (e.g. under /tmp)
 * @param {string} [opts.fileName] — filename Monday shows
 * @returns {Promise<Record<string, unknown>>} Parsed `add_file_to_column` asset payload
 */
export async function uploadPdfToMonday({ apiToken, itemId, fileColumnId, filePath, fileName = 'ds160-english-summary.pdf' }) {
  if (!itemId) throw new Error('uploadPdfToMonday: itemId is required')
  if (!fileColumnId) throw new Error('uploadPdfToMonday: fileColumnId is required')
  if (!filePath) throw new Error('uploadPdfToMonday: filePath is required')

  const buf = await fs.readFile(filePath)
  if (!buf.length) throw new Error('uploadPdfToMonday: PDF file is empty')

  /** GraphQL variable $file is bound via multipart `map` (Monday file API). */
  const gql = `mutation ($file: File!) {
    add_file_to_column(
      item_id: ${JSON.stringify(String(itemId))},
      column_id: ${JSON.stringify(String(fileColumnId))},
      file: $file
    ) {
      id
      name
      url
      public_url
      file_extension
      file_size
    }
  }`

  const form = new FormData()
  form.append('query', gql)
  form.append('map', JSON.stringify({ pdf: ['variables.file'] }))
  form.append('pdf', new File([buf], fileName, { type: 'application/pdf' }))

  const res = await fetch(MONDAY_FILE_URL, {
    method: 'POST',
    headers: {
      Authorization: apiToken,
      'API-Version': '2024-10',
    },
    body: form,
  })

  const raw = await res.text()
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`Monday file API returned non-JSON (${res.status}): ${raw.slice(0, 200)}`)
  }

  if (!res.ok) {
    const msgs = graphqlErrorMessages(json)
    throw new Error(
      msgs.length
        ? `Monday file upload HTTP ${res.status}: ${msgs.join('; ')}`
        : `Monday file upload HTTP ${res.status}: ${raw.slice(0, 400)}`,
    )
  }

  const msgs = graphqlErrorMessages(json)
  if (msgs.length) {
    throw new Error(`Monday file upload GraphQL: ${msgs.join('; ')}`)
  }

  const data = /** @type {Record<string, unknown>} */ (json?.data)
  const asset = /** @type {Record<string, unknown> | null | undefined} */ (data?.add_file_to_column)
  if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string') {
    throw new Error('uploadPdfToMonday: missing add_file_to_column in response')
  }

  return asset
}

/**
 * Optional: post metadata as an item update (requires `updates:write` on the token; failures are non-fatal).
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.itemId
 * @param {unknown} opts.metadata
 */
async function tryCreateUpdateWithMetadata({ apiToken, itemId, metadata }) {
  if (metadata == null || (typeof metadata === 'object' && metadata !== null && Object.keys(metadata).length === 0)) {
    return
  }
  const jsonText = JSON.stringify(metadata, null, 2).slice(0, 8000)
  const body = `<pre>${escapeHtml(jsonText)}</pre>`
  const query = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
  `
  try {
    await mondayGraphqlRequest({
      apiToken,
      query,
      variables: { itemId: String(itemId), body },
    })
  } catch (e) {
    console.warn('[api/monday] create_update (metadata) skipped:', e?.message || e)
  }
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * End-to-end: create item → write PDF to /tmp → upload to Files column → delete temp file.
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.boardId
 * @param {string} opts.fileColumnId
 * @param {string} opts.applicantName
 * @param {string} opts.pdfBase64 — raw base64 (no data: prefix required)
 * @param {string} [opts.status]
 * @param {unknown} [opts.metadata]
 * @returns {Promise<{ success: true, itemId: string, fileUpload: Record<string, unknown> }>}
 */
export async function sendPdfToMonday({
  apiToken,
  boardId,
  fileColumnId,
  applicantName,
  pdfBase64,
  status,
  metadata,
}) {
  const b64 = String(pdfBase64 || '').replace(/\s/g, '').replace(/^data:application\/pdf;base64,/, '')
  if (!b64) {
    throw new Error('sendPdfToMonday: pdfBase64 is required')
  }

  let buf
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    throw new Error('sendPdfToMonday: invalid base64 PDF')
  }

  if (!buf.length) throw new Error('sendPdfToMonday: decoded PDF is empty')
  if (buf.length > MAX_PDF_BYTES) {
    throw new Error(`sendPdfToMonday: PDF exceeds max size (${MAX_PDF_BYTES} bytes)`)
  }
  if (buf.slice(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('sendPdfToMonday: decoded bytes are not a PDF (missing %PDF- header)')
  }

  const itemId = await createMondayItem({ apiToken, boardId, applicantName, status })

  const tmpPath = path.join('/tmp', `ds160-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`)
  try {
    await fs.writeFile(tmpPath, buf)

    const fileUpload = await uploadPdfToMonday({
      apiToken,
      itemId,
      fileColumnId,
      filePath: tmpPath,
      fileName: 'ds160-english-summary.pdf',
    })

    await tryCreateUpdateWithMetadata({ apiToken, itemId, metadata })

    return { success: true, itemId, fileUpload }
  } finally {
    try {
      await fs.unlink(tmpPath)
    } catch {
      /* ignore missing file or failed write */
    }
  }
}

function requireMondayEnv() {
  const apiToken = process.env.MONDAY_API_TOKEN?.trim()
  const boardId = process.env.MONDAY_BOARD_ID?.trim()
  const fileColumnId = process.env.MONDAY_FILE_COLUMN_ID?.trim()
  if (!apiToken || !boardId || !fileColumnId) {
    throw Object.assign(
      new Error(
        'Monday.com is not configured. Set MONDAY_API_TOKEN, MONDAY_BOARD_ID, and MONDAY_FILE_COLUMN_ID in Vercel env.',
      ),
      { code: 'MONDAY_DISABLED' },
    )
  }
  return { apiToken, boardId, fileColumnId }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  }

  let mondayEnv
  try {
    mondayEnv = requireMondayEnv()
  } catch (e) {
    const code =
      typeof e === 'object' && e !== null && 'code' in e ? String(/** @type {{ code?: unknown }} */ (e).code) : ''
    return jsonResponse(res, 503, {
      success: false,
      error: e?.message || 'Monday not configured',
      ...(code ? { code } : {}),
    })
  }

  try {
    const body = await readBodyJson(req)
    const applicantName = typeof body.applicantName === 'string' ? body.applicantName : ''
    const pdfBase64 = typeof body.pdfBase64 === 'string' ? body.pdfBase64 : ''
    const status = typeof body.status === 'string' ? body.status : undefined
    const metadata = body.metadata

    const result = await sendPdfToMonday({
      apiToken: mondayEnv.apiToken,
      boardId: mondayEnv.boardId,
      fileColumnId: mondayEnv.fileColumnId,
      applicantName,
      pdfBase64,
      status,
      metadata,
    })

    return jsonResponse(res, 200, result)
  } catch (e) {
    const message = e?.message || 'Monday send failed'
    console.error('[api/monday]', e)
    const code = e && typeof e === 'object' && 'code' in e ? String(/** @type {{ code?: unknown }} */ (e).code) : ''
    return jsonResponse(res, 400, {
      success: false,
      error: message,
      ...(code ? { code } : {}),
    })
  }
}
