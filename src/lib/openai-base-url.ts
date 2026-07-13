/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Canonicalises a user-supplied OpenAI-compatible base URL so the `/v1` suffix
 * is present and there is no trailing slash. The AI SDK constructs upstream
 * URLs as `${baseURL}${path}` where `path` is e.g. `/chat/completions`; a
 * baseURL without `/v1` sends the request to the wrong path (404), and a
 * baseURL with a trailing slash produces `//chat/completions` which some
 * servers reject. Applying the same normalisation to the `Load Models` fetch
 * and the runtime provider keeps both paths in lockstep.
 */
export const normalizeOpenAiBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}
