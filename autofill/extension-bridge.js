#!/usr/bin/env node
/**
 * Local planner for the employee Chrome extension.
 * Binds to 127.0.0.1 so CEAC https pages never call it directly —
 * the extension popup talks to this process.
 *
 *   npm run extension-bridge
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createBlankTestPhoto, ocrCaptchaImage } from './agent.js'
import { persistDs160Pdfs } from './save-confirmation-pdf.js'
import { planCurrentPage } from './plan-current-page.js'
import { parseApplicantSource } from './parse-applicant-source.js'

function blankPhotoBytes() {
  try {
    const photo = createBlankTestPhoto()
    if (photo?.length && photo.length <= 240 * 1024) return photo
  } catch { /* fall back to the checked-in JPEG */ }
  return readFileSync(new URL('./blank-test-photo.jpg', import.meta.url))
}

const PORT = Number(process.env.DS160_EXTENSION_BRIDGE_PORT || 8787)
const HOST = '127.0.0.1'

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    json(res, 204, {})
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true })
    return
  }
  if (req.method === 'GET' && (req.url === '/blank-photo' || req.url?.startsWith('/blank-photo?'))) {
    const photo = blankPhotoBytes()
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(photo)
    return
  }
  if (req.method === 'POST' && req.url === '/plan') {
    try {
      const body = JSON.parse(await readBody(req) || '{}')
      const parsed = parseApplicantSource(body.source || '')
      const plan = await planCurrentPage({
        href: body.href || '',
        heading: body.heading || '',
        pageContext: body.pageContext,
        inventory: body.inventory,
        answers: parsed.text,
        answerSheet: parsed.answerSheet,
        autonomous: Boolean(body.autonomous),
        apiKey: body.autonomous ? process.env.OPENAI_API_KEY?.trim() : '',
        signedSubmitted: Boolean(body.signedSubmitted),
        hasSignButton: Boolean(body.hasSignButton),
      })
      json(res, 200, {
        ...plan,
        formId: parsed.embeddedFormId,
        answerSheetError: parsed.answerSheetError,
      })
    } catch (err) {
      json(res, 400, { error: err.message })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/ocr-captcha') {
    try {
      const body = JSON.parse(await readBody(req) || '{}')
      const apiKey = process.env.OPENAI_API_KEY?.trim()
      if (!apiKey) {
        json(res, 500, { error: 'OPENAI_API_KEY is not set in the repo .env' })
        return
      }
      const answer = await ocrCaptchaImage(body.image || '', apiKey)
      if (!answer) {
        json(res, 422, { error: 'Could not read the letter CAPTCHA. Try Fill again, or type it yourself.' })
        return
      }
      json(res, 200, { answer })
    } catch (err) {
      json(res, 400, { error: err.message })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/save-pdfs') {
    try {
      const body = JSON.parse(await readBody(req) || '{}')
      const result = await persistDs160Pdfs(
        body.formId,
        {
          confirmationPdf: body.confirmationPdf,
          applicationPdf: body.applicationPdf,
        },
        (message) => console.log(`[save-pdfs] ${message}`),
      )
      json(res, 200, { ok: true, ...result })
    } catch (err) {
      json(res, 400, { error: err.message })
    }
    return
  }
  json(res, 404, { error: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`DS-160 extension bridge http://${HOST}:${PORT}`)
  console.log('Load unpacked extension/ in Chrome, open CEAC, then Fill this page.')
})
