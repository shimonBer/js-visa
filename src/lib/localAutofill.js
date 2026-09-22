const LOCAL_FILL = 'http://127.0.0.1:47821'
const TIMEOUT_MS = 1500

export function autofillSourceText(text, formId) {
  const source = String(text || '').trim()
  if (!source) return ''
  if (source.startsWith('# DS160_FORM_ID=')) return source
  const id = String(formId || '').trim()
  return id ? `# DS160_FORM_ID=${id}\n${source}` : source
}

async function readJson(res) {
  return res.json().catch(() => ({}))
}

/**
 * Ask the fill window on this computer to queue the translation and start it.
 * Any failure returns started:false so the portal can keep the download.
 */
export async function startLocalAutofill({
  text,
  formId,
  fileName,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  localFill = LOCAL_FILL,
} = {}) {
  const source = autofillSourceText(text, formId)
  if (!source || typeof fetchImpl !== 'function') {
    return { started: false, reason: 'empty' }
  }
  const post = async (path, body) => {
    const res = await fetchImpl(`${localFill}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await readJson(res)
    if (!res.ok) throw new Error(data.error || 'local fill rejected the request')
    return data
  }
  try {
    const addedState = await post('/api/add-uploads', {
      files: [{ name: fileName || 'translated_auto_fill.txt', text: source }],
    })
    const item = Array.isArray(addedState.added) ? addedState.added[0] : null
    if (!item?.id) return { started: false, reason: 'missing-id' }
    if (item.status === 'filling') {
      return { started: true, id: item.id, alreadyRunning: true }
    }
    await post('/api/play', { id: item.id })
    return { started: true, id: item.id, alreadyRunning: false }
  } catch {
    return { started: false, reason: 'offline' }
  }
}
