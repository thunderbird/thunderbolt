/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'

/**
 * Extracts plain text from a DOCX blob via a lazily-imported mammoth: the
 * model wants prose, not markup, so we use mammoth's raw-text path. The
 * preview renders the pages with docx-preview instead.
 */
export const docxToText = async (file: StoredFile): Promise<{ text: string }> => {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.blob.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return { text: result.value.trim() }
}
