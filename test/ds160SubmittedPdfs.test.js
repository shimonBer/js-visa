import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DS160_APPLICATION_FIELD,
  DS160_APPLICATION_FILE,
  DS160_CONFIRMATION_FIELD,
  DS160_CONFIRMATION_FILE,
  ds160SubmittedPdfFileName,
  ds160SubmittedPdfKeys,
  hasDs160AutofillSuccess,
  isDs160SubmittedPdfFileName,
  pathnameMatchesFormId,
  siblingDs160SubmittedPdfFileName,
  resolveS3UploadApiUrl,
  submittedPdfsFromDocuments,
} from '../lib/ds160SubmittedPdfs.js'

test('ds160 submitted PDF keys use the form UUID prefix', () => {
  const formId = '5ec455c8-2024-4cbc-ac1a-f9e601f44618'
  assert.deepEqual(ds160SubmittedPdfKeys(formId), [
    {
      field: DS160_CONFIRMATION_FIELD,
      fileName: DS160_CONFIRMATION_FILE,
      key: `${formId}/${DS160_CONFIRMATION_FILE}`,
    },
    {
      field: DS160_APPLICATION_FIELD,
      fileName: DS160_APPLICATION_FILE,
      key: `${formId}/${DS160_APPLICATION_FILE}`,
    },
  ])
})

test('ds160 submitted PDF names are prefixed with first_last', () => {
  const formId = '5ec455c8-2024-4cbc-ac1a-f9e601f44618'
  const names = { firstName: 'SHIRA', lastName: 'LORENTZ REINER' }
  assert.equal(
    ds160SubmittedPdfFileName(DS160_CONFIRMATION_FILE, names),
    'shira_lorentz_reiner_ds160-confirmation.pdf',
  )
  assert.deepEqual(ds160SubmittedPdfKeys(formId, names), [
    {
      field: DS160_CONFIRMATION_FIELD,
      fileName: 'shira_lorentz_reiner_ds160-confirmation.pdf',
      key: `${formId}/shira_lorentz_reiner_ds160-confirmation.pdf`,
    },
    {
      field: DS160_APPLICATION_FIELD,
      fileName: 'shira_lorentz_reiner_ds160-application.pdf',
      key: `${formId}/shira_lorentz_reiner_ds160-application.pdf`,
    },
  ])
  assert.equal(
    siblingDs160SubmittedPdfFileName('shira_lorentz_reiner_ds160-confirmation.pdf'),
    'shira_lorentz_reiner_ds160-application.pdf',
  )
  assert.equal(isDs160SubmittedPdfFileName('shira_lorentz_reiner_ds160-application.pdf'), true)
  assert.equal(
    ds160SubmittedPdfFileName(DS160_CONFIRMATION_FILE, {
      translatedText: 'Surname: LORENTZ REINER\nGiven Name: SHIRA\n',
    }),
    'shira_lorentz_reiner_ds160-confirmation.pdf',
  )
})

test('submitted PDF file names keep a prefixed object name', () => {
  const formId = 'form-1'
  const fileName = 'shira_lorentz_reiner_ds160-confirmation.pdf'
  const docs = submittedPdfsFromDocuments(
    [{ field: DS160_CONFIRMATION_FIELD, key: `${formId}/${fileName}` }],
    formId,
  )
  assert.equal(docs[0].fileName, fileName)
})

test('resolveS3UploadApiUrl prefers S3_UPLOAD_API_URL then VITE_S3_UPLOAD_API_URL', () => {
  assert.equal(resolveS3UploadApiUrl({}), '')
  assert.equal(
    resolveS3UploadApiUrl({ VITE_S3_UPLOAD_API_URL: 'https://js-visa.vercel.app/api/upload' }),
    'https://js-visa.vercel.app/api/upload',
  )
  assert.equal(
    resolveS3UploadApiUrl({
      S3_UPLOAD_API_URL: 'https://example.test/api/upload',
      VITE_S3_UPLOAD_API_URL: 'https://js-visa.vercel.app/api/upload',
    }),
    'https://example.test/api/upload',
  )
})

test('submittedPdfsFromDocuments keeps only confirmation and application fields', () => {
  const formId = 'form-1'
  const docs = submittedPdfsFromDocuments(
    [
      { field: 'passportScan', key: `${formId}/passportScan.jpg` },
      { field: DS160_CONFIRMATION_FIELD, key: `${formId}/${DS160_CONFIRMATION_FILE}` },
      { field: DS160_APPLICATION_FIELD, key: `${formId}/${DS160_APPLICATION_FILE}`, bucket: 'js_visa' },
    ],
    formId,
  )
  assert.equal(docs.length, 2)
  assert.equal(docs[0].fileName, DS160_CONFIRMATION_FILE)
  assert.equal(docs[1].fileName, DS160_APPLICATION_FILE)
})

test('hasDs160AutofillSuccess requires confirmation and full application PDFs', () => {
  const formId = 'form-1'
  assert.equal(hasDs160AutofillSuccess([], formId), false)
  assert.equal(
    hasDs160AutofillSuccess(
      [{ field: DS160_APPLICATION_FIELD, key: `${formId}/${DS160_APPLICATION_FILE}` }],
      formId,
    ),
    false,
  )
  assert.equal(
    hasDs160AutofillSuccess(
      [{ field: DS160_CONFIRMATION_FIELD, key: `${formId}/${DS160_CONFIRMATION_FILE}` }],
      formId,
    ),
    false,
  )
  assert.equal(
    hasDs160AutofillSuccess(
      [
        { field: DS160_CONFIRMATION_FIELD, key: `${formId}/${DS160_CONFIRMATION_FILE}` },
        { field: DS160_APPLICATION_FIELD, key: `${formId}/${DS160_APPLICATION_FILE}` },
      ],
      formId,
    ),
    true,
  )
  assert.equal(isDs160SubmittedPdfFileName(DS160_CONFIRMATION_FILE), true)
  assert.equal(isDs160SubmittedPdfFileName('passportScan.jpg'), false)
})

test('pathnameMatchesFormId matches readable blob keys', () => {
  const formId = '5ec455c8-2024-4cbc-ac1a-f9e601f44618'
  assert.equal(
    pathnameMatchesFormId(`forms/shimi_berko_${formId}.json`, formId),
    true,
  )
  assert.equal(
    pathnameMatchesFormId('forms/shimi_berko_other.json', formId),
    false,
  )
})
