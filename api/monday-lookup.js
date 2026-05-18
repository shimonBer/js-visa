/**
 * POST /api/monday-lookup
 * Body: { phone: string }
 * Response: { found: boolean, itemId?: string, itemName?: string }
 *
 * Safety — read-only: uses GraphQL `items_page_by_column_values` (query only). No mutations.
 *
 * When MONDAY_API_TOKEN, MONDAY_BOARD_ID, or MONDAY_PHONE_COLUMN_ID is missing,
 * or phone is blank, returns { found: false } (HTTP 200) so the UI degrades gracefully.
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
  query ItemsByPhone($boardId: ID!, $columnId: String!, $val: String!) {
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
  const phoneColumnId = process.env.MONDAY_PHONE_COLUMN_ID?.trim()

  if (!apiToken || !boardId || !phoneColumnId) {
    return jsonResponse(res, 200, { found: false })
  }

  let body
  try {
    body = await readBodyJson(req)
  } catch (e) {
    return jsonResponse(res, 400, { found: false, error: e?.message || 'Invalid body' })
  }

  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : ''
  if (!rawPhone || !rawPhone.startsWith('+') || rawPhone.length < 8) {
    return jsonResponse(res, 200, { found: false })
  }

  /** Monday phone search: digits-only partial/full match (see items_page_by_column_values docs). */
  const searchVal = rawPhone.replace(/\D/g, '')
  if (searchVal.length < 7) {
    return jsonResponse(res, 200, { found: false })
  }

  try {
    const json = await mondayGraphqlRequest({
      apiToken,
      query: LOOKUP_QUERY,
      variables: {
        boardId,
        columnId: phoneColumnId,
        val: searchVal,
      },
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
    const id = first && typeof first.id === 'string' ? first.id : ''
    const name = first && typeof first.name === 'string' ? first.name : ''
    if (id) {
      return jsonResponse(res, 200, { found: true, itemId: id, itemName: name || id })
    }
    return jsonResponse(res, 200, { found: false })
  } catch (e) {
    console.error('[api/monday-lookup]', e?.message || e)
    return jsonResponse(res, 200, { found: false })
  }
}
