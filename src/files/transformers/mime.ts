/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** MIME type for `.docx` (OOXML Word documents). */
export const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** MIME type for `.xlsx` (OOXML spreadsheets). */
export const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Conversion target. */
export type TransformTarget = 'text' | 'images'

/** True for file types whose bytes are already user-readable text. */
export const isPlainTextMime = (mime: string): boolean => mime.startsWith('text/') || mime === 'application/json'

/** Default delivery keeps text and spreadsheets readable to every model. */
export const defaultDeliveryMode = (mime: string): TransformTarget | undefined =>
  isPlainTextMime(mime) || mime === xlsxMime ? 'text' : undefined
