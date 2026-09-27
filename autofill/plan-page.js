/**
 * DS-160 Per-Page Batch Planner
 *
 * planPage() makes ONE text-only chat.completions call per page state
 * (no screenshot) and returns an ordered array of all actions needed for the
 * current section, plus OpenAI usage stats for cost tracking.
 *
 * The planner uses a json_schema structured output so parsing never fails with
 * the JSON-cleaning heuristics askAgent needs. The system prompt is composed
 * from the static AGENT_CORE_RULES + the page-specific PAGE_RULES slice, both
 * prefix-cacheable across calls for the same page context.
 */

import process from 'node:process'
import { buildPlannerSystemPrompt } from './agent.js'
import { OPENAI_MODELS } from '../lib/openaiModels.js'
import { nextAdvanceAction, queueWithAdvance } from './done-advance.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const PLANNER_TIMEOUT_MS = 60_000

/**
 * JSON Schema for the structured planner output.
 * Each element of the `actions` array is one DS-160 action.
 */
const ACTIONS_SCHEMA = {
  type: 'object',
  required: ['actions'],
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        additionalProperties: true,
        properties: {
          type:       { type: 'string' },
          label:      { type: 'string' },
          value:      { type: ['string', 'number'] },
          text:       { type: 'string' },
          ref:        { type: 'string' },
          occurrence: { type: 'integer' },
          reason:     { type: 'string' },
          fieldLabel: { type: 'string' },
        },
      },
    },
  },
}

/**
 * The planner-specific intro that replaces the vision-agent intro.
 * Explains that the model receives a field inventory rather than a screenshot.
 */
const PLANNER_INTRO = `You are a DS-160 visa form filling planner.

You will receive:
1. FIELD INVENTORY — a JSON array of all visible form fields on the current page, each with:
   - ref: short id for direct DOM routing (include it verbatim in your output actions)
   - kind: "text" | "select" | "select-large" | "radio" | "checkbox" | "textarea" | "date"
   - label: the visible field label on screen
   - value: current filled value (empty string = unfilled)
   - options: available choices for selects (null for large country/state dropdowns)
   - required: whether the field has a validator
   - disabled: whether the field is currently inactive (skip disabled fields)
   - dnaCbxRef: ref of a linked "Does Not Apply" / "Do Not Know" checkbox (null if none)
   - row: 1-based occurrence for repeat rows (null for single fields)
   - triggersPostback: true if selecting/changing this field reloads part of the page
2. PAGE BUTTONS — buttons and navigation links available (use exact text for click actions)
3. APPLICANT DATA — the applicant's information for this section
4. VALIDATION ERRORS (optional) — errors currently visible on the page; fix these first

Your task: output a JSON object {"actions":[...]} containing the COMPLETE ORDERED list of
actions needed to fill and submit this page. Include ALL fields, not just the first one.

PLANNING RULES:
- Output actions in top-to-bottom, left-to-right order (match the field inventory order)
- Skip disabled fields and already-filled fields (value is non-empty) unless fixing a validation error
- Include a "ref" property matching the field's ref in every action where it is available
- For fields that triggersPostback=true: insert a {"type":"wait"} action immediately after
- For repeat rows: use the field's row number as the "occurrence" value
- For "select-large" fields (countries, states): use {"type":"selectOption"} with the exact
  visible option text from APPLICANT DATA; do not guess option values
- End with the appropriate Next/Continue click action using the exact button text from PAGE BUTTONS
- If APPLICANT DATA is missing required fields (❗ MISSING), skip those fields (or check Does Not Apply / Do Not Know when a checkbox exists), then still click Next. Never output {"type":"done"}
- If there are no unfilled required fields and no validation errors, output just the Next button click
- Never output {"type":"done"}. The application is not finished until Sign and Submit and the confirmation PDFs are saved.

CRITICAL — N/A / DO NOT KNOW / DOES NOT APPLY handling:
- NEVER type the literal strings "DO NOT KNOW", "DOES NOT APPLY", "N/A", or "DOES NOT APPLY" into any text field.
- When the applicant data says N/A, DO NOT KNOW, or DOES NOT APPLY for a field:
  * If the inventory field has a dnaCbxRef → output {"type":"check","label":"Do Not Know","fieldLabel":"<label>"}
    or {"type":"check","label":"Does Not Apply","fieldLabel":"<label>"} as appropriate.
  * If no dnaCbxRef → skip the field entirely (leave it blank).
- When the applicant data provides a real value → fill it normally (never use marker text as a value).
- Phone number fields must be filled with digits only. Strip +, spaces, hyphens, and parentheses: "+972 538055645" → "972538055645".`

async function fetchWithTimeout(url, options, timeoutMs = PLANNER_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal })
    return resp
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Plan all actions for the current DS-160 page in one LLM call.
 *
 * @param {object} opts
 * @param {string}  opts.pageContext   Detected page context (e.g. "personal1")
 * @param {object}  opts.inventory     Result of extractPageInventory()
 * @param {string}  opts.answers       Filtered translated text for this page section
 * @param {string[]} opts.validationErrors  Currently visible validation errors
 * @param {string}  opts.apiKey        OpenAI API key
 * @param {string[]} [opts.actionHistory] Recent action history (for context in error recovery)
 * @returns {Promise<{actions: object[], usage: object}>}
 */
export async function planPage({
  pageContext,
  inventory,
  answers,
  validationErrors = [],
  apiKey,
  actionHistory = [],
}) {
  const systemPrompt = PLANNER_INTRO + '\n\n' + buildPlannerSystemPrompt(pageContext)

  // Format the inventory compactly — omit null/empty fields to reduce tokens
  const compactFields = inventory.fields.map((f) => {
    const out = { ref: f.ref, kind: f.kind, label: f.label }
    if (f.value)            out.value = f.value
    if (f.required)         out.required = true
    if (f.disabled)         out.disabled = true
    if (f.dnaCbxRef)        out.dnaCbxRef = f.dnaCbxRef
    if (f.row !== null)     out.row = f.row
    if (f.triggersPostback) out.triggersPostback = true
    if (f.options)          out.options = f.options.map((o) => o.text || o.value)
    return out
  })

  const inventoryText =
    'FIELD INVENTORY:\n' + JSON.stringify(compactFields, null, 2) +
    '\n\nPAGE BUTTONS:\n' +
    inventory.buttons.map((b) => `- "${b.text}"${b.triggersPostback ? ' (triggers postback)' : ''}`).join('\n')

  const validationText = validationErrors.length
    ? '\n\nVALIDATION ERRORS (fix these first):\n' + validationErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')
    : ''

  const historyText = actionHistory.length
    ? '\n\nRECENT ACTIONS (already executed):\n' +
      actionHistory.slice(-10).map((a, i) => `${i + 1}. ${JSON.stringify(a)}`).join('\n')
    : ''

  const userMessage =
    inventoryText +
    '\n\nAPPLICANT DATA:\n' + answers +
    validationText +
    historyText +
    '\n\nOutput the complete ordered JSON action plan for this page:'

  const resp = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODELS.autofill,
      max_completion_tokens: 4096,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'ds160_page_plan',
          strict: false,
          schema: ACTIONS_SCHEMA,
        },
      },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '(no body)')
    throw new Error(`planPage OpenAI error ${resp.status}: ${errText.slice(0, 300)}`)
  }

  const json = await resp.json()
  const choice = json?.choices?.[0]
  const usage  = json?.usage || {}

  const raw = choice?.message?.content?.trim() || ''
  if (!raw) {
    const refusal = choice?.message?.refusal
    throw new Error(`planPage empty response (refusal="${String(refusal || '').slice(0, 120)}", finish_reason=${choice?.finish_reason})`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`planPage non-JSON response: ${raw.slice(0, 300)}`)
  }

  const actions = queueWithAdvance(
    Array.isArray(parsed?.actions) ? parsed.actions : [],
    nextAdvanceAction({ inventory, pageContext }),
  )

  return { actions, usage }
}
