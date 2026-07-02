/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Converts a DOCX blob to HTML via a lazily-imported mammoth. Used by the
 * document preview pane. mammoth stays out of the entry bundle because this
 * import only runs on the DOCX path.
 *
 * This is the preview sibling of {@link docxToText} — both live here so the
 * viewer and the delivery pipeline share one mammoth dependency and one code
 * path for DOCX handling.
 */
export const docxToHtml = async (blob: Blob): Promise<string> => {
  const mammoth = await import('mammoth')
  const arrayBuffer = await blob.arrayBuffer()
  const result = await mammoth.convertToHtml({ arrayBuffer })
  return result.value
}
