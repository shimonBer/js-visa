/**
 * POST /api/monday-lookup
 * Body: { phone?: string, email?: string }
 * Response: { found: boolean, itemId?: string, itemName?: string }
 *
 * Safety — read-only: uses GraphQL `items_page_by_column_values` (query only). No mutations.
 *
 * Search order: phone first (if provided), then email (if phone not found).
 * When required env vars are missing returns { found: false } (HTTP 200) for graceful degradation.
 */

import { mondayGraphqlRequest } from './monday.js'

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

const LOOKUP_QUERY = `
  query ItemsByColumn($boardId: ID!, $columnId: String!, $val: String!) {
    items_page_by_column_values(
      limit: 1
      board_id: $boardId
      columns: [{ column_id: $columnId, column_values: [$val] }]
    ) {
      items {
        id
        name
      }
    }
  }
`

/**
 * @param {{ apiToken: string, boardId: string, columnId: string, value: string }} opts
 * @returns {Promise<{ id: string, name: string } | null>}
 */
async function lookupByColumn({ apiToken, boardId, columnId, value }) {
  if (!columnId || !value) return null
  try {
    const json = await mondayGraphqlRequest({
      apiToken,
      query: LOOKUP_QUERY,
      variables: { boardId, columnId, val: value },
    })
    const data = json && typeof json === 'object' ? /** @type {Record<string, unknown>} */ (json).data : null
    const page =
      data && typeof data === 'object'
        ? /** @type {Record<string, unknown>} */ (data).items_page_by_column_values
        : null
    const items =
      page && typeof page === 'object' && Array.isArray(/** @type {{ items?: unknown }} */ (page).items)
        ? /** @type {{ id?: string, name?: string }[]} */ (/** @type {{ items: unknown }} */ (page).items)
        : []
    const first = items[0]
    if (first && typeof first.id === 'string' && first.id) {
      return { id: first.id, name: typeof first.name === 'string' ? first.name : '' }
    }
    return null
  } catch (e) {
    console.warn('[monday-lookup] column lookup failed:', e?.message || e)
    return null
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

  const apiToken = process.env.MONDAY_API_TOKEN?.trim()
  const boardId = process.env.MONDAY_BOARD_ID?.trim()
  const phoneColumnId = process.env.MONDAY_PHONE_COLUMN_ID?.trim() || ''
  const emailColumnId = process.env.MONDAY_EMAIL_COLUMN_ID?.trim() || ''

  if (!apiToken || !boardId) {
    return jsonResponse(res, 200, { found: false })
  }

  let body
  try {
    body = await readBodyJson(req)
  } catch (e) {
    return jsonResponse(res, 400, { found: false, error: e?.message || 'Invalid body' })
  }

  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''

  // 1. Search by phone (digits-only for Monday phone column)
  if (phoneColumnId && rawPhone && rawPhone.startsWith('+') && rawPhone.length >= 8) {
    const digits = rawPhone.replace(/\D/g, '')
    if (digits.length >= 7) {
      const hit = await lookupByColumn({ apiToken, boardId, columnId: phoneColumnId, value: digits })
      if (hit) return jsonResponse(res, 200, { found: true, itemId: hit.id, itemName: hit.name || hit.id })
    }
  }

  // 2. Fallback: search by email
  if (emailColumnId && rawEmail && rawEmail.includes('@')) {
    const hit = await lookupByColumn({ apiToken, boardId, columnId: emailColumnId, value: rawEmail })
    if (hit) return jsonResponse(res, 200, { found: true, itemId: hit.id, itemName: hit.name || hit.id })
  }

  return jsonResponse(res, 200, { found: false })
}
