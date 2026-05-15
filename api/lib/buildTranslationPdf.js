/**
 * Assembles a single PDF: English summary (text pages) + visually embedded uploads (JPEG/PNG/PDF).
 * Uses Standard Helvetica (Latin-1); non-encodable characters are approximated or dropped for text pages.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 50
const FONT_SIZE = 10
const LINE_H = 12

/**
 * @param {string} s
 */
function sanitizeForPdfDraw(s) {
  let r = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const code = c.charCodeAt(0)
    if (code === 0x0a || code === 0x0d) {
      r += ' '
      continue
    }
    if (code < 32) continue
    if (code <= 126) {
      r += c
      continue
    }
    if (code <= 255) {
      r += c
      continue
    }
    const cp = s.codePointAt(i)
    if (cp > 0xffff) i++
    if (cp === 0x2013 || cp === 0x2014) r += '-'
    else if (cp === 0x2018 || cp === 0x2019) r += "'"
    else if (cp === 0x201c || cp === 0x201d) r += '"'
    else if (cp === 0x2026) r += '...'
    else if (cp === 0x00a0) r += ' '
    else r += ' '
  }
  return r
}

/**
 * @param {string} text
 * @param {number} charsPerLine
 */
function wrapTextToLines(text, charsPerLine) {
  const normalized = String(text || '').replace(/\r\n/g, '\n')
  const out = []
  for (const para of normalized.split('\n')) {
    let rest = para
    while (rest.length > charsPerLine) {
      let breakAt = charsPerLine
      const spaceIdx = rest.lastIndexOf(' ', charsPerLine)
      if (spaceIdx > Math.floor(charsPerLine * 0.55)) breakAt = spaceIdx + 1
      const chunk = rest.slice(0, breakAt).trimEnd()
      out.push(chunk.length ? chunk : rest.slice(0, charsPerLine))
      rest = rest.slice(breakAt).trimStart()
    }
    out.push(rest)
  }
  return out
}

/**
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {import('pdf-lib').PDFFont} font
 * @param {import('pdf-lib').PDFImage} image
 * @param {string} caption
 */
async function addImageFullPage(pdfDoc, font, image, caption) {
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const iw = image.width
  const ih = image.height
  const maxW = PAGE_W - 40
  const maxH = PAGE_H - 56
  const scale = Math.min(maxW / iw, maxH / ih)
  const w = iw * scale
  const h = ih * scale
  const x = (PAGE_W - w) / 2
  const y = (PAGE_H - h) / 2 - 16
  page.drawImage(image, { x, y, width: w, height: h })
  const cap = sanitizeForPdfDraw(caption).slice(0, 140)
  page.drawText(cap, { x: MARGIN, y: PAGE_H - 26, size: 9, font, color: rgb(0.15, 0.15, 0.15) })
}

/**
 * @param {string} translated
 * @param {{ field: string, fileName: string, mimeType: string, bytes: Uint8Array }[]} binaries
 * @returns {Promise<Uint8Array>}
 */
export async function buildTranslationPdf(translated, binaries) {
  const pdfDoc = await PDFDocument.create()
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const charsPerLine = 92

  let page = pdfDoc.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  page.drawText('DS-160 English summary (generated)', {
    x: MARGIN,
    y,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  })
  y -= 28

  const lines = wrapTextToLines(translated, charsPerLine)
  for (const rawLine of lines) {
    const line = sanitizeForPdfDraw(rawLine)
    if (y < MARGIN + LINE_H) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H])
      y = PAGE_H - MARGIN
    }
    page.drawText(line || ' ', { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0, 0, 0) })
    y -= LINE_H
  }

  if (binaries.length > 0) {
    page = pdfDoc.addPage([PAGE_W, PAGE_H])
    page.drawText('ORIGINAL UPLOADS (embedded images / PDF pages)', {
      x: MARGIN,
      y: PAGE_H - MARGIN,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    })

    for (const it of binaries) {
      const mime = String(it.mimeType || '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      const caption = `${it.field} — ${it.fileName}`
      try {
        if (mime === 'application/pdf') {
          const src = await PDFDocument.load(it.bytes)
          const idx = src.getPageIndices()
          const copied = await pdfDoc.copyPages(src, idx)
          copied.forEach((p) => pdfDoc.addPage(p))
          continue
        }
        if (mime === 'image/jpeg' || mime === 'image/jpg') {
          const img = await pdfDoc.embedJpg(it.bytes)
          await addImageFullPage(pdfDoc, font, img, caption)
          continue
        }
        if (mime === 'image/png') {
          const img = await pdfDoc.embedPng(it.bytes)
          await addImageFullPage(pdfDoc, font, img, caption)
          continue
        }
        page = pdfDoc.addPage([PAGE_W, PAGE_H])
        page.drawText(sanitizeForPdfDraw(`[Format not embedded as image in PDF: ${mime} — ${caption}]`), {
          x: MARGIN,
          y: PAGE_H - MARGIN,
          size: 10,
          font,
        })
      } catch {
        page = pdfDoc.addPage([PAGE_W, PAGE_H])
        page.drawText(sanitizeForPdfDraw(`[Could not embed file: ${caption}]`), {
          x: MARGIN,
          y: PAGE_H - MARGIN,
          size: 10,
          font,
        })
      }
    }
  }

  return pdfDoc.save()
}
