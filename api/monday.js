/**
 * POST /api/monday
 * Creates a Monday.com board item and uploads the DS-160 translation PDF to the item's
 * built-in Updates/Files tab (via create_update + add_file_to_update).
 *
 * Safety — this integration never deletes or archives Monday data:
 * Mutations are only `create_item` (new row), `create_update` (text update on item),
 * and `add_file_to_update` (attach PDF to that update). No `delete_*`, `archive_*`,
 * column-clear, or board-structure mutations. Local `fs.unlink` only removes the
 * server temp file under /tmp.
 *
 * Body (JSON):
 *   { applicantName, pdfBase64, phone?, email?, mondayItemId?, status?, metadata? }
 *
 * Lookup flow (no `mondayItemId` pre-stored):
 *   1. If MONDAY_PHONE_COLUMN_ID configured and phone provided → query board by phone digits
 *   2. If not found and MONDAY_EMAIL_COLUMN_ID configured and email provided → query board by email
 *   3. If still not found → create_item with name, phone column, email column populated
 *
 * Response:
 *   { success: true, itemId: string, updateId: string, fileUpload: object }
 *   { success: false, error: string, code?: string, itemId?: string }
 *
 * Env (server only, set in Vercel — never VITE_*):
 *   MONDAY_API_TOKEN, MONDAY_BOARD_ID
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
export async function mondayGraphqlRequest({ apiToken, query, variables = {} }) {
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
 * Guess a 2-letter ISO country code from an international phone number prefix.
 * Returns 'IL' as fallback (appropriate default for this Israeli-focused form).
 * @param {string} phone
 */
function phoneToCountryCode(phone) {
  const p = String(phone || '').replace(/[\s\-().]/g, '')
  if (p.startsWith('+972')) return 'IL'
  if (p.startsWith('+1')) return 'US'
  if (p.startsWith('+44')) return 'GB'
  if (p.startsWith('+33')) return 'FR'
  if (p.startsWith('+49')) return 'DE'
  if (p.startsWith('+7')) return 'RU'
  if (p.startsWith('+34')) return 'ES'
  if (p.startsWith('+39')) return 'IT'
  if (p.startsWith('+31')) return 'NL'
  if (p.startsWith('+32')) return 'BE'
  if (p.startsWith('+41')) return 'CH'
  if (p.startsWith('+43')) return 'AT'
  if (p.startsWith('+48')) return 'PL'
  if (p.startsWith('+380')) return 'UA'
  if (p.startsWith('+90')) return 'TR'
  if (p.startsWith('+91')) return 'IN'
  if (p.startsWith('+86')) return 'CN'
  if (p.startsWith('+81')) return 'JP'
  if (p.startsWith('+82')) return 'KR'
  if (p.startsWith('+55')) return 'BR'
  if (p.startsWith('+54')) return 'AR'
  if (p.startsWith('+61')) return 'AU'
  return 'IL'
}

/**
 * Look up a single item in the board by an exact column value.
 * Returns { id, name } on match, or null on no match / error.
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.boardId
 * @param {string} opts.columnId
 * @param {string} opts.value — search term passed to column_values
 * @returns {Promise<{ id: string, name: string } | null>}
 */
async function lookupItemByColumn({ apiToken, boardId, columnId, value }) {
  if (!columnId || !value) return null
  const query = `
    query LookupByColumn($boardId: ID!, $columnId: String!, $val: String!) {
      items_page_by_column_values(
        limit: 1
        board_id: $boardId
        columns: [{ column_id: $columnId, column_values: [$val] }]
      ) {
        items { id name }
      }
    }
  `
  try {
    const json = await mondayGraphqlRequest({
      apiToken,
      query,
      variables: { boardId, columnId, val: value },
    })
    const data = /** @type {Record<string, unknown>} */ (json.data)
    const page = /** @type {{ items?: unknown[] }} */ (
      data && typeof data === 'object' ? data.items_page_by_column_values : null
    )
    const items = Array.isArray(page?.items) ? /** @type {{ id?: string, name?: string }[]} */ (page.items) : []
    const first = items[0]
    if (first && typeof first.id === 'string' && first.id) {
      return { id: first.id, name: String(first.name || '') }
    }
    return null
  } catch (e) {
    console.warn('[monday] lookupItemByColumn skipped:', e?.message || e)
    return null
  }
}

/**
 * Create a board item (pulse) with the given display name and optional column values.
 * `columnValues` keys are column IDs; values are Monday column value objects.
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.boardId
 * @param {string} opts.applicantName
 * @param {string} [opts.groupId] — board group to create the item in
 * @param {string} [opts.status]
 * @param {Record<string, unknown>} [opts.columnValues]
 * @returns {Promise<string>} New item id
 */
export async function createMondayItem({ apiToken, boardId, applicantName, groupId, status, columnValues }) {
  const name = String(applicantName || '').trim()
  if (!name) {
    throw new Error('createMondayItem: applicantName is required')
  }
  const itemName =
    status != null && String(status).trim() !== '' ? `${name} — ${String(status).trim()}` : name

  const hasCols = columnValues && Object.keys(columnValues).length > 0
  const hasGroup = typeof groupId === 'string' && groupId.trim()

  const extraArgs = [
    hasGroup ? ', $groupId: String' : '',
    hasCols ? ', $colVals: JSON' : '',
  ].join('')
  const extraCallArgs = [
    hasGroup ? ', group_id: $groupId' : '',
    hasCols ? ', column_values: $colVals' : '',
  ].join('')

  /** Monday's `column_values` arg expects a JSON scalar (serialized as object in variables). */
  const query = `
    mutation CreateItem($boardId: ID!, $itemName: String!${extraArgs}) {
      create_item(board_id: $boardId, item_name: $itemName${extraCallArgs}) {
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
      ...(hasGroup ? { groupId: String(groupId).trim() } : {}),
      ...(hasCols ? { colVals: columnValues } : {}),
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
 * Create an item update (text body) and attach a PDF file to it via `add_file_to_update`.
 * The attached file appears in the item's built-in Files tab and Updates feed.
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.itemId
 * @param {string} opts.filePath — absolute path to PDF on disk (e.g. under /tmp)
 * @param {string} [opts.fileName]
 * @param {unknown} [opts.metadata] — optional extra data serialised into the update body
 * @returns {Promise<{ updateId: string, asset: Record<string, unknown> }>}
 */
export async function createUpdateAndUploadPdf({ apiToken, itemId, filePath, fileName = 'ds160-english-summary.pdf', metadata }) {
  if (!itemId) throw new Error('createUpdateAndUploadPdf: itemId is required')
  if (!filePath) throw new Error('createUpdateAndUploadPdf: filePath is required')

  // Build update body — always includes "DS-160" label; append metadata if provided
  let bodyText = '📄 DS-160 English Summary'
  if (metadata != null && !(typeof metadata === 'object' && metadata !== null && Object.keys(metadata).length === 0)) {
    const jsonText = JSON.stringify(metadata, null, 2).slice(0, 6000)
    bodyText += `\n\n<pre>${escapeHtml(jsonText)}</pre>`
  }

  // Step 1: create_update → get update id
  const updateQuery = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `
  const updateJson = await mondayGraphqlRequest({
    apiToken,
    query: updateQuery,
    variables: { itemId: String(itemId), body: bodyText },
  })
  const updateData = /** @type {Record<string, unknown>} */ (updateJson.data)
  const updateId = /** @type {{ id?: string } | undefined} */ (updateData?.create_update)?.id
  if (!updateId || typeof updateId !== 'string') {
    throw new Error('createUpdateAndUploadPdf: missing create_update.id in Monday response')
  }

  // Step 2: add_file_to_update → attach PDF to that update
  const buf = await fs.readFile(filePath)
  if (!buf.length) throw new Error('createUpdateAndUploadPdf: PDF file is empty')

  const gql = `mutation ($file: File!) {
    add_file_to_update(update_id: ${JSON.stringify(String(updateId))}, file: $file) {
      id name url public_url file_extension file_size
    }
  }`

  const form = new FormData()
  form.append('query', gql)
  form.append('map', JSON.stringify({ pdf: ['variables.file'] }))
  form.append('pdf', new File([buf], fileName, { type: 'application/pdf' }))

  const res = await fetch(MONDAY_FILE_URL, {
    method: 'POST',
    headers: { Authorization: apiToken, 'API-Version': '2024-10' },
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
  if (msgs.length) throw new Error(`Monday file upload GraphQL: ${msgs.join('; ')}`)

  const data = /** @type {Record<string, unknown>} */ (json?.data)
  const asset = /** @type {Record<string, unknown> | null | undefined} */ (data?.add_file_to_update)
  if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string') {
    throw new Error('createUpdateAndUploadPdf: missing add_file_to_update in response')
  }

  return { updateId, asset }
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
 * End-to-end: resolve/create item → write PDF to /tmp → create update + attach PDF → delete temp file.
 * The PDF appears in the item's built-in Files tab and Updates feed.
 *
 * @param {object} opts
 * @param {string} opts.apiToken
 * @param {string} opts.boardId
 * @param {string} opts.applicantName
 * @param {string} opts.pdfBase64 — raw base64 (no data: prefix required)
 * @param {string} [opts.phone] — applicant phone (used for lookup if no mondayItemId)
 * @param {string} [opts.email] — applicant email (used for lookup if no mondayItemId and phone lookup fails)
 * @param {string} [opts.mondayItemId] — pre-stored item id (skips lookup entirely)
 * @param {string} [opts.phoneColumnId] — Monday column id for the phone field
 * @param {string} [opts.emailColumnId] — Monday column id for the email field
 * @param {string} [opts.groupId] — board group id to create new items in
 * @param {string} [opts.itemUrlPrefix] — optional URL prefix to build item link
 * @param {string} [opts.status]
 * @param {unknown} [opts.metadata]
 * @returns {Promise<{ success: true, itemId: string, updateId: string, isNew: boolean, itemUrl: string, fileUpload: Record<string, unknown> }>}
 */
export async function sendPdfToMonday({
  apiToken,
  boardId,
  applicantName,
  pdfBase64,
  phone,
  email,
  mondayItemId,
  phoneColumnId,
  emailColumnId,
  groupId,
  itemUrlPrefix,
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

  // ── Resolve item id ──────────────────────────────────────────────────────
  // Priority: 1) pre-stored mondayItemId  2) lookup by phone  3) lookup by email  4) create new
  const storedId = typeof mondayItemId === 'string' ? mondayItemId.trim() : ''
  const phoneStr = typeof phone === 'string' ? phone.trim() : ''
  const emailStr = typeof email === 'string' ? email.trim() : ''

  let resolvedItemId = storedId
  let isNew = false

  if (!resolvedItemId) {
    // 1. Try phone lookup
    if (phoneColumnId && phoneStr) {
      const digitsOnly = phoneStr.replace(/\D/g, '')
      if (digitsOnly.length >= 7) {
        const hit = await lookupItemByColumn({ apiToken, boardId, columnId: phoneColumnId, value: digitsOnly })
        if (hit) resolvedItemId = hit.id
      }
    }
    // 2. Try email lookup if phone not found
    if (!resolvedItemId && emailColumnId && emailStr) {
      const hit = await lookupItemByColumn({ apiToken, boardId, columnId: emailColumnId, value: emailStr })
      if (hit) resolvedItemId = hit.id
    }
    // 3. Create new item with phone + email columns populated
    if (!resolvedItemId) {
      /** @type {Record<string, unknown>} */
      const colVals = {}
      if (phoneColumnId && phoneStr) {
        colVals[phoneColumnId] = { phone: phoneStr, countryShortName: phoneToCountryCode(phoneStr) }
      }
      if (emailColumnId && emailStr) {
        colVals[emailColumnId] = { email: emailStr, text: emailStr }
      }
      resolvedItemId = await createMondayItem({
        apiToken,
        boardId,
        applicantName,
        groupId,
        status,
        columnValues: Object.keys(colVals).length ? colVals : undefined,
      })
      isNew = true
    }
  }
  const itemId = resolvedItemId

  const tmpPath = path.join('/tmp', `ds160-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`)
  try {
    await fs.writeFile(tmpPath, buf)

    const { updateId, asset: fileUpload } = await createUpdateAndUploadPdf({
      apiToken,
      itemId,
      filePath: tmpPath,
      fileName: 'ds160-english-summary.pdf',
      metadata,
    })

    const itemUrl =
      typeof itemUrlPrefix === 'string' && itemUrlPrefix.trim()
        ? `${itemUrlPrefix.trim().replace(/\/$/, '')}/${itemId}`
        : ''

    return /** @type {const} */ ({ success: true, itemId, updateId, isNew, itemUrl, fileUpload })
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
  if (!apiToken || !boardId) {
    throw Object.assign(
      new Error('Monday.com is not configured. Set MONDAY_API_TOKEN and MONDAY_BOARD_ID in Vercel env.'),
      { code: 'MONDAY_DISABLED' },
    )
  }
  return {
    apiToken,
    boardId,
    phoneColumnId: process.env.MONDAY_PHONE_COLUMN_ID?.trim() || '',
    emailColumnId: process.env.MONDAY_EMAIL_COLUMN_ID?.trim() || '',
    groupId: process.env.MONDAY_GROUP_ID?.trim() || '',
    itemUrlPrefix: process.env.MONDAY_ITEM_URL_PREFIX?.trim() || '',
  }
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
    const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    // accept both mondayItemId (new) and existingItemId (legacy) for compatibility
    const mondayItemId =
      typeof body.mondayItemId === 'string' && body.mondayItemId.trim()
        ? body.mondayItemId.trim()
        : typeof body.existingItemId === 'string' && body.existingItemId.trim()
          ? body.existingItemId.trim()
          : ''
    const status = typeof body.status === 'string' ? body.status : undefined
    const metadata = body.metadata

    const result = await sendPdfToMonday({
      apiToken: mondayEnv.apiToken,
      boardId: mondayEnv.boardId,
      phoneColumnId: mondayEnv.phoneColumnId,
      emailColumnId: mondayEnv.emailColumnId,
      groupId: mondayEnv.groupId,
      itemUrlPrefix: mondayEnv.itemUrlPrefix,
      applicantName,
      pdfBase64,
      phone,
      email,
      mondayItemId,
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
