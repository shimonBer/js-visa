import { firstFile } from './uploadFormDocuments.js'

/**
 * Strips File inputs and adds lightweight file metadata for JSON / localStorage.
 */
export function serializeFormValuesForJson(values) {
  const data = { ...values }
  const fileMeta = {}

  for (const key of ['passportScan', 'existingVisaScan', 'socialSecurityScan', 'americanLicenseScan']) {
    const f = firstFile(data[key])
    delete data[key]
    fileMeta[key] = f
      ? { name: f.name, size: f.size, type: f.type || null }
      : null
  }

  return { data, fileMeta }
}
