/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'

/**
 * Transformer for files that are already text (CSV, plain text, Markdown, JSON).
 * There's nothing to extract — we just decode the bytes — but routing it through
 * the transformer registry lets the delivery pipeline treat text files uniformly
 * (deliver as a text block, which every transport accepts losslessly) instead of
 * an opaque file part a text-only endpoint can't carry.
 */
export const textPassthrough = async (file: StoredFile): Promise<{ text: string }> => ({
  text: await file.blob.text(),
})
