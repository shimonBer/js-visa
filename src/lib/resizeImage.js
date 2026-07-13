let _pdfjsLib = null
async function getPdfjsLib() {
  if (_pdfjsLib) return _pdfjsLib
  _pdfjsLib = await import('pdfjs-dist')
  _pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).href
  return _pdfjsLib
}

/**
 * Convert the first page of a PDF file to a JPEG File using pdfjs-dist.
 * @param {File} file
 * @param {{ scale?: number, quality?: number }} options
 * @returns {Promise<File>}
 */
async function pdfToImageFile(file, { scale = 2, quality = 0.88 } = {}) {
  const pdfjsLib = await getPdfjsLib()
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const page = await pdf.getPage(1)
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('Canvas toBlob failed for PDF'))
        resolve(new File([blob], file.name.replace(/\.pdf$/i, '.jpg'), { type: 'image/jpeg' }))
      },
      'image/jpeg',
      quality,
    )
  })
}

/**
 * Resize an image File to fit within maxDim x maxDim at the given JPEG quality.
 * PDFs are rendered to an image via pdfjs-dist (first page).
 * @param {File} file
 * @param {{ maxDim?: number, quality?: number }} options
 * @returns {Promise<File>}
 */
export async function resizeImageFile(file, { maxDim = 2000, quality = 0.88 } = {}) {
  if (file.type === 'application/pdf') {
    return pdfToImageFile(file, { quality })
  }
  if (!file.type.startsWith('image/')) return file

  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width <= maxDim && height <= maxDim) {
        // Already small enough — still re-encode as JPEG to strip EXIF / reduce size
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0)
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error('Canvas toBlob failed'))
            resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }))
          },
          'image/jpeg',
          quality,
        )
        return
      }

      const ratio = Math.min(maxDim / width, maxDim / height)
      width = Math.round(width * ratio)
      height = Math.round(height * ratio)

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('Canvas toBlob failed'))
          resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }))
        },
        'image/jpeg',
        quality,
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not load image for resizing'))
    }

    img.src = url
  })
}
