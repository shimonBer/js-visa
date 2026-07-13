/**
 * Resize an image File to fit within maxDim x maxDim at the given JPEG quality.
 * PDFs are returned unchanged (can't be canvas-resized in the browser).
 * @param {File} file
 * @param {{ maxDim?: number, quality?: number }} options
 * @returns {Promise<File>}
 */
export async function resizeImageFile(file, { maxDim = 2000, quality = 0.88 } = {}) {
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
