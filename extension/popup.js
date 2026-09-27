const BRIDGE = 'http://127.0.0.1:8787'
const logEl = document.getElementById('log')
const fileStatus = document.getElementById('fileStatus')
const bridgeStatus = document.getElementById('bridgeStatus')

function log(value) {
  logEl.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function friendlyError(err) {
  const msg = err?.message || String(err)
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return 'Bridge is not running. In the repo: npm run extension-bridge'
  }
  if (/Cannot access contents|must request permission|Cannot access a chrome|Cannot access contents of the page/i.test(msg)) {
    return 'Click the extension icon while the CEAC form tab is focused, then try again.'
  }
  return msg
}

function showStatus(status) {
  if (!status) return
  if (typeof status === 'string') {
    log(status)
    return
  }
  log({
    message: status.message,
    history: status.history,
    current: status.current,
    note: status.note,
    stopped: status.stopped,
    ok: status.ok,
    running: status.running,
  })
}

async function loadStoredSource() {
  const { source, sourceName } = await chrome.storage.local.get(['source', 'sourceName'])
  if (source) fileStatus.textContent = `Loaded: ${sourceName || 'applicant file'} (${source.length} chars)`
  return source || ''
}

document.getElementById('file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  if (!file) return
  const source = await file.text()
  await chrome.storage.local.set({ source, sourceName: file.name })
  fileStatus.textContent = `Loaded: ${file.name} (${source.length} chars)`
})

async function activeCeacTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !/ceac\.state\.gov/i.test(tab.url || '')) {
    throw new Error('Active tab is not CEAC. Open the DS-160 form first.')
  }
  return tab
}

document.getElementById('dryRun').addEventListener('click', async () => {
  try {
    const { planOnePage } = await import('./runner.js')
    const source = await loadStoredSource()
    const tab = await activeCeacTab()
    const { snap, planned } = await planOnePage(tab.id, source)
    if (planned.pageContext !== 'captcha' && !source) {
      throw new Error('Load a translated applicant file first.')
    }
    log({
      note: planned.note,
      pageContext: planned.pageContext,
      source: planned.source,
      href: snap.href,
      heading: snap.heading,
      fields: snap.inventory?.fields?.length || 0,
      actions: planned.actions,
      unresolvedRequired: planned.unresolvedRequired,
      nextClick: planned.nextClick,
    })
  } catch (err) {
    log(friendlyError(err))
  }
})

document.getElementById('fill').addEventListener('click', async () => {
  try {
    const source = await loadStoredSource()
    if (!source) throw new Error('Load a translated applicant file first.')
    const tab = await activeCeacTab()
    const res = await chrome.runtime.sendMessage({
      type: 'startAutofill',
      tabId: tab.id,
      source,
    })
    if (res?.error) throw new Error(res.error)
    log('Filling in the background. You can close this popup.')
  } catch (err) {
    log(friendlyError(err))
  }
})

document.getElementById('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stopAutofill' }).catch(() => {})
  log('Stop requested.')
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'fillStatus') showStatus(message.status)
})

async function pingBridge() {
  try {
    const res = await fetch(`${BRIDGE}/health`)
    const body = await res.json()
    bridgeStatus.textContent = body.ok ? 'Bridge: connected' : 'Bridge: unexpected response'
  } catch {
    bridgeStatus.textContent = 'Bridge: not running (npm run extension-bridge)'
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.fillStatus) showStatus(changes.fillStatus.newValue)
})

chrome.storage.session.get(['fillStatus']).then(({ fillStatus }) => {
  if (fillStatus) showStatus(fillStatus)
})

loadStoredSource()
pingBridge()
