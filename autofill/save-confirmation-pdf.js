import fs from 'fs'
import path from 'path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import {
  DS160_APPLICATION_FILE,
  DS160_CONFIRMATION_FILE,
  ds160SubmittedPdfKeys,
  resolveS3UploadApiUrl,
} from '../lib/ds160SubmittedPdfs.js'

function sanitizeFormId(value) {
  const id = String(value || '').trim()
  return /^[a-zA-Z0-9_-]{3,200}$/.test(id) ? id : ''
}

function s3ClientFromEnv() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim()
  if (!accessKeyId || !secretAccessKey) return null

  return new S3Client({
    region:
      process.env.S3_REGION?.trim() ||
      process.env.AWS_S3_REGION?.trim() ||
      process.env.AWS_REGION?.trim() ||
      'eu-north-1',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken && { sessionToken }),
    },
  })
}

async function waitForPrintablePage(page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.evaluate(async () => {
    await document.fonts?.ready
    await Promise.all(
      Array.from(document.images).map((image) => {
        if (image.complete) return Promise.resolve()
        return new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true })
          image.addEventListener('error', resolve, { once: true })
        })
      }),
    )
  })
}

async function renderPagePdf(page) {
  await waitForPrintablePage(page)
  return page.pdf({
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
  })
}

async function openPrintApplication(page, log) {
  const printApplicationButton = page
    .locator([
      '#ctl00_SiteContentPlaceHolder_FormView1_btnPrintApp',
      'input[name="ctl00$SiteContentPlaceHolder$FormView1$btnPrintApp"]',
      'input.printapp',
    ].join(', '))
    .first()

  await printApplicationButton.waitFor({ state: 'visible', timeout: 20_000 })
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }),
    printApplicationButton.click(),
  ])

  const stillOnConfirmation = await page
    .locator('#ctl00_SiteContentPlaceHolder_FormView1_btnPrintApp')
    .isVisible()
    .catch(() => false)
  if (stillOnConfirmation) {
    throw new Error('Print Application was clicked, but CEAC remained on the confirmation page.')
  }

  log(`Opened CEAC Print Application page: ${page.url()}`)
}

export async function saveConfirmationPdf(page, formId, log = console.log) {
  await page.waitForSelector('h2:has-text("Confirmation")', {
    state: 'visible',
    timeout: 20_000,
  })

  const confirmationPdf = await renderPagePdf(page)
  await openPrintApplication(page, log)
  const applicationPdf = await renderPagePdf(page)
  return persistDs160Pdfs(formId, { confirmationPdf, applicationPdf }, log)
}

function toPdfBuffer(value) {
  if (!value) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  const raw = String(value).replace(/^data:application\/pdf;base64,/, '')
  return raw ? Buffer.from(raw, 'base64') : null
}

function submittedPdfRefs(formId, bucket) {
  return ds160SubmittedPdfKeys(formId).map((item) => ({
    field: item.field,
    key: item.key,
    ...(bucket ? { bucket } : {}),
  }))
}

async function uploadPdfViaApi(apiUrl, formId, fileName, buf) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Form-Id': formId,
      'X-File-Name': fileName,
    },
    body: buf,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Upload API ${res.status}: ${text.slice(0, 240)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export async function persistDs160Pdfs(formId, { confirmationPdf, applicationPdf } = {}, log = console.log) {
  const safeFormId = sanitizeFormId(formId)
  if (!safeFormId || safeFormId === 'incomplete') {
    throw new Error(
      'A valid applicant form UUID is required to save the confirmation PDF. ' +
      'Download a new translated file or pass --form-id <uuid>.',
    )
  }

  const confirmationBuf = toPdfBuffer(confirmationPdf)
  const applicationBuf = toPdfBuffer(applicationPdf)
  if (!confirmationBuf?.length) throw new Error('Confirmation PDF is empty')
  if (!applicationBuf?.length) throw new Error('Application PDF is empty')

  const outputDir = path.resolve('autofill-output', safeFormId)
  fs.mkdirSync(outputDir, { recursive: true })

  const confirmationPath = path.join(outputDir, DS160_CONFIRMATION_FILE)
  const applicationPath = path.join(outputDir, DS160_APPLICATION_FILE)
  fs.writeFileSync(confirmationPath, confirmationBuf)
  log(`Saved confirmation PDF locally: ${confirmationPath}`)
  fs.writeFileSync(applicationPath, applicationBuf)
  log(`Saved full Print Application PDF locally: ${applicationPath}`)

  const [confirmationMeta, applicationMeta] = ds160SubmittedPdfKeys(safeFormId)
  const confirmationKey = confirmationMeta.key
  const applicationKey = applicationMeta.key
  const bucket =
    process.env.S3_BUCKET?.trim() ||
    process.env.S3_BUCKET_NAME?.trim() ||
    'js_visa'

  const localResult = {
    localPath: confirmationPath,
    confirmationPath,
    applicationPath,
    confirmationKey,
    applicationKey,
    s3Documents: submittedPdfRefs(safeFormId, bucket),
    uploaded: false,
  }

  const apiUrl = resolveS3UploadApiUrl()
  if (apiUrl) {
    try {
      const [confirmationUp, applicationUp] = await Promise.all([
        uploadPdfViaApi(apiUrl, safeFormId, DS160_CONFIRMATION_FILE, confirmationBuf),
        uploadPdfViaApi(apiUrl, safeFormId, DS160_APPLICATION_FILE, applicationBuf),
      ])
      const resolvedBucket = confirmationUp.bucket || applicationUp.bucket || bucket
      log(`Uploaded confirmation PDF via ${apiUrl} → ${confirmationUp.key || confirmationKey}`)
      log(`Uploaded full Print Application PDF via ${apiUrl} → ${applicationUp.key || applicationKey}`)
      return {
        ...localResult,
        bucket: resolvedBucket,
        key: confirmationUp.key || confirmationKey,
        applicationKey: applicationUp.key || applicationKey,
        s3Documents: submittedPdfRefs(safeFormId, resolvedBucket),
        uploaded: true,
        via: 'upload-api',
      }
    } catch (err) {
      log(`⚠️  Upload API failed (${err.message}). Trying direct S3 if AWS credentials are set.`)
    }
  }

  const client = s3ClientFromEnv()
  if (!client) {
    log(
      `⚠️  DS-160 PDFs saved locally but not uploaded (set S3_UPLOAD_API_URL or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). ` +
        `Local files: ${confirmationPath}, ${applicationPath}`,
    )
    return localResult
  }

  try {
    await Promise.all([
      client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: confirmationKey,
        Body: confirmationBuf,
        ContentType: 'application/pdf',
      })),
      client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: applicationKey,
        Body: applicationBuf,
        ContentType: 'application/pdf',
      })),
    ])
  } catch (err) {
    log(
      `⚠️  DS-160 PDFs saved locally but S3 upload failed (${err.message}). ` +
        `Local files: ${confirmationPath}, ${applicationPath}`,
    )
    return localResult
  }
  log(`Uploaded confirmation PDF to s3://${bucket}/${confirmationKey}`)
  log(`Uploaded full Print Application PDF to s3://${bucket}/${applicationKey}`)

  return {
    ...localResult,
    bucket,
    key: confirmationKey,
    uploaded: true,
    via: 's3',
  }
}
