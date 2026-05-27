/**
 * Assembles a single PDF: English summary (text pages) + visually embedded uploads (JPEG/PNG/PDF).
 * Embeds Noto Sans (Google Fonts) for Hebrew + Latin in the text portion; falls back to Helvetica if fetch fails.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 50
const FONT_SIZE = 10
const LINE_H = 12

const COLOR_HEADER_BG = rgb(0.22, 0.27, 0.68)
const COLOR_HEADER_TEXT = rgb(1, 1, 1)
const COLOR_MISSING = rgb(0.82, 0.22, 0.12)
const COLOR_LABEL = rgb(0.18, 0.22, 0.42)
const COLOR_BODY = rgb(0.08, 0.08, 0.1)
const COLOR_RULE = rgb(0.78, 0.8, 0.88)

/**
 * @param {string} raw
 * @returns {'blank' | 'section-header' | 'missing' | 'field-label' | 'body'}
 */
function classifyPdfLine(raw) {
  const trim = String(raw ?? '').trim()
  if (!trim) return 'blank'
  if (/^🟦/.test(trim)) return 'section-header'
  if (trim.includes('❗ MISSING')) return 'missing'
  if (/^\*\*/.test(trim)) return 'field-label'
  if (/^Document:/i.test(trim) || /^Mapped to DS-160/i.test(trim)) return 'field-label'
  return 'body'
}

const NOTO_SANS_TTF_URL =
  'https://raw.githubusercontent.com/googlefonts/noto-fonts/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf'

/** @type {Uint8Array | null | undefined} undefined = not tried, null = failed */
let cachedNotoBytes = undefined

async function getNotoSansBytes() {
  if (cachedNotoBytes !== undefined) return cachedNotoBytes
  try {
    const res = await fetch(NOTO_SANS_TTF_URL)
    if (!res.ok) {
      console.warn('[buildTranslationPdf] Noto font HTTP', res.status)
      cachedNotoBytes = null
      return null
    }
    cachedNotoBytes = new Uint8Array(await res.arrayBuffer())
    return cachedNotoBytes
  } catch (e) {
    console.warn('[buildTranslationPdf] Noto font fetch failed', e)
    cachedNotoBytes = null
    return null
  }
}

/**
 * Strip control chars only; keep Hebrew and full Unicode for embedded fonts.
 * @param {string} s
 */
function sanitizePdfText(s) {
  let out = ''
  for (const ch of String(s || '')) {
    const c = ch.charCodeAt(0)
    if (c >= 32 || c === 9) out += ch
  }
  return out
}

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
 * @param {boolean} captionUnicode
 */
async function addImageFullPage(pdfDoc, font, image, caption, captionUnicode) {
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
  const capRaw = (captionUnicode ? sanitizePdfText(caption) : sanitizeForPdfDraw(caption)).slice(0, 200)
  page.drawText(capRaw || ' ', { x: MARGIN, y: PAGE_H - 26, size: 9, font, color: rgb(0.15, 0.15, 0.15) })
}

/**
 * @param {string} translated
 * @param {{ field: string, fileName: string, mimeType: string, bytes: Uint8Array }[]} binaries
 * @returns {Promise<Uint8Array>}
 */
export async function buildTranslationPdf(translated, binaries) {
  const pdfDoc = await PDFDocument.create()
  const notoBytes = await getNotoSansBytes()
  /** @type {import('pdf-lib').PDFFont} */
  let textFont
  let useUnicode = false
  if (notoBytes && notoBytes.length > 0) {
    try {
      textFont = await pdfDoc.embedFont(notoBytes, { subset: false })
      useUnicode = true
    } catch (e) {
      console.warn('[buildTranslationPdf] embed Noto failed', e)
      textFont = await pdfDoc.embedFont(StandardFonts.Helvetica)
    }
  } else {
    textFont = await pdfDoc.embedFont(StandardFonts.Helvetica)
  }

  const captionFont = textFont
  const charsPerLine = useUnicode ? 72 : 92
  /** Narrower wrap when body lines are slightly indented */
  const charsBody = Math.max(40, charsPerLine - 4)

  const lineForDraw = (raw) => (useUnicode ? sanitizePdfText(raw) : sanitizeForPdfDraw(raw))

  let helveticaBold
  try {
    helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  } catch {
    helveticaBold = textFont
  }

  let page = pdfDoc.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  page.drawText(lineForDraw('DS-160 English summary (generated)'), {
    x: MARGIN,
    y,
    size: 13,
    font: useUnicode ? textFont : helveticaBold,
    color: COLOR_LABEL,
  })
  y -= 10
  page.drawLine({
    start: { x: MARGIN, y: y + 4 },
    end: { x: PAGE_W - MARGIN, y: y + 4 },
    thickness: 1,
    color: COLOR_RULE,
  })
  y -= 22

  const paragraphs = String(translated || '').replace(/\r\n/g, '\n').split('\n')

  /**
   * @param {number} need
   */
  function ensureVerticalSpace(need) {
    if (y < MARGIN + need) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H])
      y = PAGE_H - MARGIN
    }
  }

  for (const rawPara of paragraphs) {
    const kind = classifyPdfLine(rawPara)
    if (kind === 'blank') {
      y -= 6
      ensureVerticalSpace(LINE_H)
      continue
    }

    const wrapWidth =
      kind === 'field-label'
        ? charsPerLine - 6
        : kind === 'section-header'
          ? charsPerLine - 2
          : charsBody
    const wrapped = wrapTextToLines(rawPara, wrapWidth)

    for (let i = 0; i < wrapped.length; i++) {
      const rawLine = wrapped[i]
      const line = lineForDraw(rawLine)
      /** Only first line of a 🟦 block gets the full-width bar */
      const drawKind =
        kind === 'section-header' && i > 0 ? 'header-continuation' : kind === 'section-header' ? 'section-header' : kind

      const indent = drawKind === 'body' ? MARGIN + 10 : drawKind === 'header-continuation' ? MARGIN + 8 : MARGIN
      let size = FONT_SIZE
      let color = COLOR_BODY
      let font = textFont
      let extraGap = 0

      if (drawKind === 'section-header') {
        ensureVerticalSpace(36)
        const barH = 22
        const barBottom = y
        page.drawRectangle({
          x: MARGIN,
          y: barBottom - barH,
          width: PAGE_W - 2 * MARGIN,
          height: barH,
          color: COLOR_HEADER_BG,
        })
        try {
          page.drawText(line || ' ', {
            x: MARGIN + 8,
            y: barBottom - barH + 6,
            size: 11,
            font: textFont,
            color: COLOR_HEADER_TEXT,
          })
        } catch (e) {
          console.warn('[buildTranslationPdf] section header draw failed', e)
        }
        y = barBottom - barH - 10
        extraGap = 0
        continue
      }

      if (drawKind === 'header-continuation') {
        ensureVerticalSpace(LINE_H + 4)
        size = 10
        color = COLOR_HEADER_BG
        try {
          page.drawText(line || ' ', { x: indent, y, size, font: textFont, color })
        } catch (e) {
          console.warn('[buildTranslationPdf] header continuation draw failed', e)
        }
        y -= LINE_H + 2
        continue
      }

      if (drawKind === 'missing') {
        size = 10
        color = COLOR_MISSING
      } else if (drawKind === 'field-label') {
        size = 9
        color = COLOR_LABEL
        font = useUnicode ? textFont : helveticaBold
        extraGap = i === 0 ? 4 : 0
      } else {
        size = FONT_SIZE
        color = COLOR_BODY
      }

      if (extraGap) y -= extraGap
      ensureVerticalSpace(LINE_H + 4)
      try {
        page.drawText(line || ' ', { x: indent, y, size, font, color })
      } catch (e) {
        page.drawText('[line omitted — unsupported characters]', {
          x: indent,
          y,
          size: FONT_SIZE,
          font: textFont,
          color: rgb(0.5, 0, 0),
        })
        console.warn('[buildTranslationPdf] drawText line failed', e)
      }
      y -= drawKind === 'field-label' ? LINE_H : LINE_H + 1
    }

    if (kind === 'section-header') {
      y -= 4
    }
  }

  if (binaries.length > 0) {
    page = pdfDoc.addPage([PAGE_W, PAGE_H])
    const sectionTitle = 'ORIGINAL UPLOADS (embedded images / PDF pages)'
    page.drawText(sectionTitle, {
      x: MARGIN,
      y: PAGE_H - MARGIN,
      size: 14,
      font: textFont,
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
          await addImageFullPage(pdfDoc, captionFont, img, caption, useUnicode)
          continue
        }
        if (mime === 'image/png') {
          const img = await pdfDoc.embedPng(it.bytes)
          await addImageFullPage(pdfDoc, captionFont, img, caption, useUnicode)
          continue
        }
        page = pdfDoc.addPage([PAGE_W, PAGE_H])
        page.drawText(lineForDraw(`[Format not embedded as image in PDF: ${mime} — ${caption}]`), {
          x: MARGIN,
          y: PAGE_H - MARGIN,
          size: 10,
          font: textFont,
        })
      } catch {
        page = pdfDoc.addPage([PAGE_W, PAGE_H])
        page.drawText(lineForDraw(`[Could not embed file: ${caption}]`), {
          x: MARGIN,
          y: PAGE_H - MARGIN,
          size: 10,
          font: textFont,
        })
      }
    }
  }

  return pdfDoc.save()
}
