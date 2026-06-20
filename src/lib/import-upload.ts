/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ImportFormatError } from '@/dal'

/**
 * Hard ceiling on the size of an import file we'll attempt to read into
 * memory. The export doc calls out ~100 MB as the practical limit even for
 * heavy users; 200 MB is generous head-room. Anything larger almost
 * certainly isn't a Thunderbolt export, so we refuse it before paying the
 * `file.text()` allocation — picking the wrong file on Tauri iOS would
 * otherwise freeze or OOM the WebView.
 */
const maxImportBytes = 200 * 1024 * 1024

/**
 * Reads a `File` (from an `<input type="file">`) as text and parses it as
 * JSON. Returns `unknown` so the caller validates the shape before using it.
 *
 * Throws an {@link ImportFormatError} when the file exceeds
 * {@link maxImportBytes}, or a `SyntaxError` with the original file name in
 * the message when the JSON doesn't parse — easier to surface in the UI
 * than the raw parser error.
 */
export const readJsonFile = async (file: File): Promise<unknown> => {
  if (file.size > maxImportBytes) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(0)
    const maxMb = maxImportBytes / 1024 / 1024
    throw new ImportFormatError(
      `"${file.name}" is too large (${sizeMb} MB). Maximum supported import size is ${maxMb} MB.`,
    )
  }
  const text = await file.text()
  try {
    return JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown parse error'
    throw new SyntaxError(`Could not parse "${file.name}" as JSON: ${reason}`, { cause: error })
  }
}
