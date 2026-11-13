/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { normalizeOpenAiBaseUrl } from './openai-base-url'

/**
 * Canonical form of a URL a credential is sent to, so two spellings of one
 * endpoint compare equal. WHATWG parsing folds scheme and host case, drops a
 * default port and resolves dot segments; the fragment never leaves the client,
 * so it is dropped. Scheme, host, port, the exact path (trailing slash
 * included) and the query all count. Null when the URL doesn't parse.
 */
export const credentialDestination = (raw: string | null | undefined): string | null => {
  const trimmed = raw?.trim()
  if (!trimmed || !URL.canParse(trimmed)) {
    return null
  }
  const url = new URL(trimmed)
  url.hash = ''
  return url.href
}

/** Whether a credential saved for `approved` may be sent to `target`. A URL that doesn't parse matches nothing. */
export const isSameCredentialDestination = (
  approved: string | null | undefined,
  target: string | null | undefined,
): boolean => {
  const destination = credentialDestination(approved)
  return destination !== null && destination === credentialDestination(target)
}

/** A model's provider and URL, or the pair a key was saved for (null on a key saved before binding). */
type ModelDestinationFields = { provider: string | null; url: string | null }

/**
 * Where a model's API key is sent. Hosted providers have a fixed endpoint, so
 * the provider alone names it; a Custom model sends the key to its normalized
 * base URL (see `resolveOpenAiCompatConnection`).
 */
export const modelKeyDestination = ({ provider, url }: ModelDestinationFields): string | null => {
  if (provider !== 'custom') {
    return provider
  }
  return url ? credentialDestination(normalizeOpenAiBaseUrl(url)) : null
}

/** Whether a key saved for `approved` may be sent where `target` points. */
export const isSameModelKeyDestination = (
  approved: ModelDestinationFields,
  target: ModelDestinationFields,
): boolean => {
  const destination = modelKeyDestination(approved)
  return destination !== null && destination === modelKeyDestination(target)
}
