/**
 * DS-160 Page Inventory
 *
 * extractPageInventory(page) runs collectPageInventory() in the page so the
 * Chrome extension and Playwright share one snapshot.
 */

import {
  collectPageInventory,
  FORM_PREFIX,
  LARGE_SELECT_THRESHOLD,
} from './collect-page-inventory.js'

/**
 * Extract a structured inventory of the current DS-160 page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   fields: object[],
 *   buttons: {ref:string, text:string, triggersPostback:boolean}[],
 *   errors: string[],
 *   signature: string,
 * }>}
 */
export async function extractPageInventory(page) {
  const raw = await page.evaluate(
    collectPageInventory,
    { prefix: FORM_PREFIX, largeThreshold: LARGE_SELECT_THRESHOLD },
  )
  return applyDateLabels(raw)
}

export function applyDateLabels(inventory) {
  if (!inventory?.fields) return inventory
  for (const field of inventory.fields) {
    if (field.kind !== 'date') continue
    const known = DATE_LABELS[field.ref.replace(/^.*_ctl\d+_/, '')]
    if (known) field.label = known
  }
  return inventory
}

/**
 * Display labels for date groups, keyed by control name. The form's own markup is
 * too inconsistent to scrape (see pass 2), and these are the words the planner —
 * and executeAction's legacy label-based date routing — need to see.
 */
const DATE_LABELS = {
  DOB: 'Date of Birth',
  FathersDOB: "Father's Date of Birth",
  MothersDOB: "Mother's Date of Birth",
  PPT_ISSUED_DTE: 'Passport Issuance Date',
  PPT_EXPIRE_DTE: 'Passport Expiration Date',
  // Shown instead of ARRIVAL_US_DTE when the applicant has no specific plans.
  TRAVEL_DTE: 'Intended Date of Arrival',
  ARRIVAL_US_DTE: 'Date of Arrival in U.S.',
  DEPARTURE_US_DTE: 'Date of Departure from U.S.',
  PREV_VISA_ISSUED_DTE: 'Date Last Visa Was Issued',
  PREV_US_VISIT_DTE: 'Previous U.S. Visit Arrival Date',
  SchoolFrom: 'Attendance From',
  SchoolTo: 'Attendance To',
  EmpDateFrom: 'Employment Start Date',
  EmpDateTo: 'Employment End Date',
  MILITARY_SVC_FROM: 'Military Service From',
  MILITARY_SVC_TO: 'Military Service To',
}

/**
 * Compute a diff between two inventories.
 * Returns { added, removed, changed } arrays of refs.
 */
export function diffInventory(prev, next) {
  const prevMap = new Map(prev.fields.map((f) => [f.ref, f]))
  const nextMap = new Map(next.fields.map((f) => [f.ref, f]))

  const added   = next.fields.filter((f) => !prevMap.has(f.ref))
  const removed = prev.fields.filter((f) => !nextMap.has(f.ref))
  const changed = next.fields.filter((f) => {
    const p = prevMap.get(f.ref)
    return p && (p.value !== f.value || p.disabled !== f.disabled)
  })

  return { added, removed, changed }
}

/**
 * Return refs from the inventory that have no value and are not disabled
 * (i.e., still need to be filled), minus any refs covered by a pending action queue.
 *
 * @param {object} inventory
 * @param {string[]} plannedRefs  refs already in the action queue
 * @returns {import('./page-inventory.js').InventoryField[]}
 */
export function findUnplannedRequired(inventory, plannedRefs) {
  const planned = new Set(plannedRefs)
  return inventory.fields.filter(
    (f) =>
      !planned.has(f.ref) &&
      !f.disabled &&
      f.required &&
      !f.value &&
      f.kind !== 'checkbox', // checkboxes are opt-in, not "empty"
  )
}
