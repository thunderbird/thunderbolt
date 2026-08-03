/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Attachment compression orchestrator (THU-671). When a user attaches a file
 * larger than {@link compressionThresholdBytes}, we attempt to shrink it before
 * storing/sending — but only where it's actually possible and beneficial for
 * the type. Everything falls back to the original bytes untouched.
 *
 * Scope:
 * - Raster images (png/jpeg/webp) → downscale + re-encode to WebP.
 * - GIF → skipped: canvas re-encoding would flatten animation to one frame.
 * - PDF → best-effort lossless re-save.
 * - Everything else (docx, text, csv, json) → passthrough: generic byte
 *   compression is useless here because the model has to read the bytes.
 */

/** Only try to compress files larger than this. */
export const compressionThresholdBytes = 10 * 1024 * 1024

/** Raster image types worth re-encoding. GIF is intentionally excluded so we
 *  don't flatten animated frames. */
const compressibleImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** Extension fallbacks for when the browser reports an empty/odd MIME type (a
 *  pasted screenshot, a drag from some sources) — the same reason the
 *  acceptance check keys on extension too. Kept in lock-step with the MIME sets
 *  above: GIF is omitted so animated frames still pass through untouched. */
const compressibleImageExtensions = ['.png', '.jpg', '.jpeg', '.webp']
const pdfExtensions = ['.pdf']

const hasExtension = (name: string, extensions: readonly string[]): boolean => {
  const lower = name.toLowerCase()
  return extensions.some((ext) => lower.endsWith(ext))
}

const isCompressibleImage = (file: File): boolean =>
  compressibleImageMimeTypes.has(file.type) || hasExtension(file.name, compressibleImageExtensions)

const isPdf = (file: File): boolean => file.type === 'application/pdf' || hasExtension(file.name, pdfExtensions)

/** Injectable so the orchestrator's routing/fallback logic is unit-testable
 *  without a canvas or pdf-lib in the test environment. */
export type CompressDeps = {
  compressImage: (blob: Blob) => Promise<Blob | null>
  compressPdf: (blob: Blob) => Promise<Blob | null>
}

const defaultDeps: CompressDeps = {
  compressImage: async (blob) => (await import('./compress-image')).compressImage(blob),
  compressPdf: async (blob) => (await import('./compress-pdf')).compressPdf(blob),
}

/** Swap a filename's extension (e.g. `photo.PNG` → `photo.webp`). */
const withExtension = (name: string, ext: string): string => {
  const dot = name.lastIndexOf('.')
  return `${dot === -1 ? name : name.slice(0, dot)}.${ext}`
}

/**
 * Return a compressed {@link File} when compression is possible and beneficial,
 * otherwise the original file unchanged. Small files and unsupported types are
 * returned immediately without loading the heavy compressors. Any compression
 * failure is swallowed in favour of the original — best-effort by design.
 */
export const maybeCompressAttachment = async (file: File, deps: CompressDeps = defaultDeps): Promise<File> => {
  if (file.size <= compressionThresholdBytes) {
    return file
  }

  try {
    if (isCompressibleImage(file)) {
      const compressed = await deps.compressImage(file)
      return compressed ? new File([compressed], withExtension(file.name, 'webp'), { type: 'image/webp' }) : file
    }
    if (isPdf(file)) {
      const compressed = await deps.compressPdf(file)
      return compressed ? new File([compressed], file.name, { type: 'application/pdf' }) : file
    }
  } catch (error) {
    console.error(`Attachment compression failed for "${file.name}", sending original:`, error)
  }

  return file
}
