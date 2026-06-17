/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reads a `File` (from an `<input type="file">`) as text and parses it as
 * JSON. Returns `unknown` so the caller validates the shape before using it.
 *
 * Throws a `SyntaxError` with the original file name in the message when the
 * JSON doesn't parse — easier to surface in the UI than the raw parser
 * error.
 */
export const readJsonFile = async (file: File): Promise<unknown> => {
  const text = await file.text()
  try {
    return JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown parse error'
    throw new SyntaxError(`Could not parse "${file.name}" as JSON: ${reason}`, { cause: error })
  }
}
