/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Converts a dropped file into the text a project stores as knowledge.
 *
 * Reuses the attachment transformers (`src/files/transformers`) rather than
 * introducing a second extraction path, so a PDF added to a project is parsed by
 * exactly the same code as a PDF attached to a message.
 *
 * Text — not bytes — because project knowledge has to sync: attachment blobs are
 * device-local by design (`src/lib/file-blob-storage.ts`), so a binary knowledge
 * base would only work on the machine that uploaded it.
 */

import { getTransformer, hasTransformer, resolveTextMimeType } from '@/files/transformers'
import type { StoredFile } from '@/lib/file-blob-storage'

/**
 * The MIME type to treat a file as. Delegates to the shared resolver in the
 * transformers layer so the composer and knowledge agree on what counts as text;
 * re-exported under this name because callers here read in knowledge terms.
 */
export const resolveKnowledgeMimeType = resolveTextMimeType

/** Per-document ceiling. A single huge file would otherwise evict every other
 *  document from the prompt budget on its own. */
export const maxKnowledgeChars = 200_000

/** Raised when a file type has no text transformer (e.g. an image). */
export class UnsupportedKnowledgeFileError extends Error {
  constructor(
    readonly filename: string,
    readonly mimeType: string,
  ) {
    super(`“${filename}” can’t be added as project knowledge — ${mimeType || 'this file type'} has no text form.`)
    this.name = 'UnsupportedKnowledgeFileError'
  }
}

/** Whether this file can become project knowledge, after MIME resolution. */
export const canExtractKnowledgeText = (mimeType: string, filename = ''): boolean =>
  hasTransformer(resolveKnowledgeMimeType(filename, mimeType), 'text')

/**
 * Extract a file's text. Throws {@link UnsupportedKnowledgeFileError} for a type
 * with no text transformer — surfaced to the user at drop time, so nothing is
 * ever silently stored as empty knowledge.
 */
export const extractKnowledgeText = async (file: StoredFile): Promise<string> => {
  const transformer = await getTransformer(resolveKnowledgeMimeType(file.filename, file.mimeType), 'text')
  if (!transformer) {
    throw new UnsupportedKnowledgeFileError(file.filename, file.mimeType)
  }
  const output = await transformer(file)
  if (!('text' in output)) {
    throw new UnsupportedKnowledgeFileError(file.filename, file.mimeType)
  }
  return output.text
}
