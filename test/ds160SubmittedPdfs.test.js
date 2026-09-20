import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DS160_APPLICATION_FIELD,
  DS160_APPLICATION_FILE,
  DS160_CONFIRMATION_FIELD,
  DS160_CONFIRMATION_FILE,
  ds160SubmittedPdfKeys,
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
