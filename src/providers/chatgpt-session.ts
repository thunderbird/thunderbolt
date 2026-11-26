/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { http } from '@/lib/http'
import { nativeFetch } from '@/lib/native-fetch'
import { createOAuthRequestSignal, oauthRequestTimeoutMs } from '@/lib/openrouter-auth'
import type { ProviderCredentials } from './types'

export const chatGPTIssuer = 'https://auth.openai.com'
export const chatGPTResource = 'https://api.openai.com/v1'
const metadataSchema = z.object({
  issuer: z.literal(chatGPTIssuer),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  revocation_endpoint: z.url(),
})

/** Pins all credential-bearing requests to OpenAI's issuer even if discovery is misconfigured. */
const fetchChatGPTMetadata = async (signal: AbortSignal) => {
  const metadata = metadataSchema.parse(
    await http
      .get(`${chatGPTIssuer}/.well-known/openid-configuration`, {
        fetch: nativeFetch,
        redirect: 'error',
        credentials: 'omit',
        signal,
      })
      .json(),
  )
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.jwks_uri,
    metadata.revocation_endpoint,
  ]) {
    const url = new URL(endpoint)
    if (url.origin !== chatGPTIssuer || url.username || url.password || url.hash) {
      throw new Error('Unexpected ChatGPT OAuth endpoint')
    }
  }
  return metadata
}

/** Ordinary discovery follows the initiating identity and caller, with a bounded body read. */
export const loadChatGPTMetadata = (signal?: AbortSignal) => fetchChatGPTMetadata(createOAuthRequestSignal(signal))

/** Revokes the renewable session before removing device tokens; failed revocation leaves a retryable connection. */
export const revokeChatGPTSession = async (credentials: ProviderCredentials) => {
  if (!credentials.refresh_token || !credentials.oauth) {
    return
  }
  // Cleanup must finish even when the identity that issued this grant has already retired.
  const signal = AbortSignal.timeout(oauthRequestTimeoutMs)
  const metadata = await fetchChatGPTMetadata(signal)
  await http.post(metadata.revocation_endpoint, {
    fetch: nativeFetch,
    redirect: 'error',
    credentials: 'omit',
    signal,
    body: new URLSearchParams({
      token: credentials.refresh_token,
      token_type_hint: 'refresh_token',
      client_id: credentials.oauth.clientId,
    }),
  })
}
