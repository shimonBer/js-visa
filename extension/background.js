import { requestStop, runAutofill } from './runner.js'

let running = false
let keepAlive = null

function armKeepAlive() {
  if (keepAlive) return
  keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {})
  }, 15000)
}

function disarmKeepAlive() {
  if (!keepAlive) return
  clearInterval(keepAlive)
  keepAlive = null
}

async function ensureOffscreen() {
  if (chrome.offscreen?.hasDocument && (await chrome.offscreen.hasDocument())) return
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Keep filling the DS-160 after the toolbar popup closes',
    })
  } catch (err) {
    if (!/already exists|Only a single offscreen/i.test(err.message || '')) {
      console.warn('offscreen keep-alive failed', err)
    }
  }
}

function report(message, extra = {}) {
  const status = {
    message,
    at: Date.now(),
    running: extra.running ?? true,
    ...extra,
  }
  chrome.storage.session.set({ fillStatus: status })
  chrome.runtime.sendMessage({ type: 'fillStatus', status }).catch(() => {})
}

async function startFill(tabId, source) {
  if (running) {
    report('Already filling', { running: true })
    return
  }
  running = true
  armKeepAlive()
  chrome.action.setBadgeText({ text: 'ON' })
  chrome.action.setBadgeBackgroundColor({ color: '#1a56db' })
  report('Starting fill…', { running: true })
  try {
    await ensureOffscreen()
    const result = await runAutofill(tabId, source, report)
    report(result.note || (result.ok ? 'Done' : 'Stopped'), { ...result, running: false })
  } catch (err) {
    report(err.message || String(err), { ok: false, running: false })
  } finally {
    running = false
    disarmKeepAlive()
    chrome.action.setBadgeText({ text: '' })
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'startAutofill') {
    sendResponse({ ok: true })
    startFill(message.tabId, message.source || '')
    return
  }
  if (message?.type === 'stopAutofill') {
    requestStop()
    sendResponse({ ok: true })
  }
})
