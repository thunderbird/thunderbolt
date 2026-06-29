/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'

/**
 * Client-side transformer registry: turns a stored attachment into a form a
 * model can consume when its transport can't accept the raw bytes (e.g. a PDF
 * for a text-only pipeline). Transformers run entirely on-device — the blobs
 * never leave IndexedDB unless a delivery plan says so.
 *
 * Each transformer is lazy-imported so its heavy dependency (pdfjs, mammoth)
 * stays out of the entry bundle and only loads when an attachment of that type
 * actually needs converting.
 */

/** A rendered image (page) produced by an image transformer, as a data URL. */
export type TransformImage = { mimeType: string; dataUrl: string }

/** What a transformer produces — extracted text, or rendered page images. */
export type TransformOutput = { text: string } | { images: TransformImage[] }

export type Transformer = (file: StoredFile) => Promise<TransformOutput>

/** Conversion target. */
export type TransformTarget = 'text' | 'images'

export type TransformerKey = `${string}->${TransformTarget}`

/** MIME type for `.docx` (OOXML Word documents). */
export const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Lazy loaders keyed by `"<source-mime>-><target>"`. Adding a transformer is a
 * one-line entry here plus its module — nothing else in the pipeline needs to
 * know the concrete type.
 */
const loaders: Partial<Record<TransformerKey, () => Promise<Transformer>>> = {
  'application/pdf->text': async () => (await import('./pdf-to-text')).pdfToText,
  [`${docxMime}->text`]: async () => (await import('./docx-to-text')).docxToText,
  'application/pdf->images': async () => (await import('./pdf-to-images')).pdfToImages,
}

/** True if a transformer exists for this source MIME → target. Sync, for routing decisions. */
export const hasTransformer = (sourceMime: string, target: TransformTarget): boolean =>
  `${sourceMime}->${target}` in loaders

/** Lazy-load the matching transformer, or `null` if none is registered. */
export const getTransformer = async (sourceMime: string, target: TransformTarget): Promise<Transformer | null> => {
  const loader = loaders[`${sourceMime}->${target}` as TransformerKey]
  return loader ? loader() : null
}
