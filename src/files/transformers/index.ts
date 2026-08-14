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
 * True for files that are already text (CSV, plain text, Markdown, JSON, logs…).
 * These get a passthrough text transformer (so any `text/*` type works without
 * enumerating it) and are delivered as text by default — see
 * {@link defaultDeliveryMode}. Excludes rich binary formats like PDF/docx, which
 * have their own extractors and a richer native representation.
 */
export const isPlainTextMime = (mime: string): boolean => mime.startsWith('text/') || mime === 'application/json'

/**
 * Extensions the OS reports with an empty or actively wrong MIME type, but which
 * are plain text.
 *
 * A file picker gives `.md` an **empty** `type`. Keying only off MIME rejects it
 * as unsupported — or worse, accepts it and then delivers raw bytes the model
 * can't read, because {@link defaultDeliveryMode} routes an unknown type as
 * native.
 *
 * Scoped to the extensions the composer accepts (see `acceptedAttachmentExtensions`
 * in `chat-prompt-input.tsx`). It was briefly much broader, to serve project
 * knowledge; listing types that can no longer be attached would only suggest
 * support that isn't there.
 */
export const plainTextExtensions: ReadonlySet<string> = new Set(['md', 'markdown', 'txt', 'csv', 'json'])

/**
 * The MIME type a file should be treated as: a declared type we can already
 * handle, otherwise an extension-based fallback to `text/plain`.
 *
 * Normalizing at the point a file enters the app is what makes the rest work —
 * {@link defaultDeliveryMode} then routes it as text instead of native bytes.
 */
export const resolveTextMimeType = (filename: string, declaredType: string): string => {
  if (declaredType && (isPlainTextMime(declaredType) || hasTransformer(declaredType, 'text'))) {
    return declaredType
  }
  const extension = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  return plainTextExtensions.has(extension) ? 'text/plain' : declaredType
}

/**
 * Default delivery mode for an attachment given its MIME type, when no explicit
 * {@link import('@/types').AttachmentData.deliverAs} override is set. Plain-text
 * files go out as text (lossless and universally accepted); everything else
 * defaults to native bytes (`undefined`).
 */
export const defaultDeliveryMode = (mime: string): TransformTarget | undefined =>
  isPlainTextMime(mime) ? 'text' : undefined

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
  `${sourceMime}->${target}` in loaders || (target === 'text' && isPlainTextMime(sourceMime))

/** Lazy-load the matching transformer, or `null` if none is registered. */
export const getTransformer = async (sourceMime: string, target: TransformTarget): Promise<Transformer | null> => {
  const loader = loaders[`${sourceMime}->${target}` as TransformerKey]
  if (loader) {
    return loader()
  }
  // Any text-ish type maps to the passthrough text transformer without an explicit entry.
  if (target === 'text' && isPlainTextMime(sourceMime)) {
    return (await import('./text-passthrough')).textPassthrough
  }
  return null
}
