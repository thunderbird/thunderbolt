/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Canonicalises a user-supplied OpenAI-compatible base URL so the `/v1` suffix
 * is present and there is no trailing slash. The AI SDK constructs upstream
 * URLs as `${baseURL}${path}` where `path` is e.g. `/chat/completions`; a
 * baseURL without `/v1` sends the request to the wrong path (404), and a
 * baseURL with a trailing slash produces `//chat/completions` which some
 * servers reject. Applied to the `Load Models` fetch and the runtime provider
 * so both compose the upstream URL from the same normalized base — the two
 * paths still dispatch their transport independently (Load Models is always a
 * direct browser fetch; the runtime provider only bypasses the proxy for
 * loopback hosts).
 */
export const normalizeOpenAiBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}
