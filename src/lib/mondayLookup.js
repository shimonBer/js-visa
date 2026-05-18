/**
 * Client for POST /api/monday-lookup (phone → Monday item search).
 */

import { getMondayApiBase } from './monday.js'

/**
 * @param {{ apiBase?: string }} [opts]
 * @returns {string}
 */
function getMondayLookupUrl(opts = {}) {
  const base = getMondayApiBase(opts)
  if (!base) return ''
  return base.replace(/\/monday\/?$/i, '/monday-lookup')
}

/**
 * @param {string} phone
 * @param {{ apiBase?: string }} [opts]
 * @returns {Promise<{ found: boolean, itemId?: string, itemName?: string }>}
 */
export async function lookupMondayItemByPhone(phone, opts = {}) {
  const url = getMondayLookupUrl(opts)
  if (!url) {
    return { found: false }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  })

  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    return { found: false }
  }

  if (!res.ok || typeof json !== 'object' || json == null) {
    return { found: false }
  }

  return {
    found: json.found === true,
    ...(typeof json.itemId === 'string' ? { itemId: json.itemId } : {}),
    ...(typeof json.itemName === 'string' ? { itemName: json.itemName } : {}),
  }
}
