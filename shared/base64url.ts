/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unpadded base64url of `text`'s UTF-8 bytes.
 *
 * Built on `btoa` rather than `Buffer`, so it behaves the same in every runtime.
 * A `typeof Buffer` check is not enough in the browser: the in-browser agent
 * installs the npm `buffer` polyfill as `globalThis.Buffer`, and that polyfill
 * has no `base64url` encoding, so `toString('base64url')` throws there.
 */
export const encodeBase64Url = (text: string): string =>
  btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** The UTF-8 text an unpadded base64url string encodes, or null when it isn't base64url. */
export const decodeBase64Url = (encoded: string): string | null => {
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
}
