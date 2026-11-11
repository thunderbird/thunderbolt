/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { providerConnectionSecretsTable as secrets } from '@/db/tables'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { http } from '@/lib/http'
import { nativeFetch } from '@/lib/native-fetch'
import {
  createProviderAuthorization,
  createOAuthRequestSignal,
  type OpenRouterAuthDependencies,
} from '@/lib/openrouter-auth'
import { generateCodeVerifier } from '@/lib/pkce'
import { isTauri, isMobile } from '@/lib/platform'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import { readChatGPTRegistration, retainChatGPTRegistration } from './chatgpt-registration'
export { readChatGPTRegistration } from './chatgpt-registration'
import { hasChatGPTPlanScope, oauthTokensSchema, withProviderOAuthLock } from './oauth-session'
import { chatGPTIssuer, chatGPTResource, loadChatGPTMetadata, revokeChatGPTSession } from './chatgpt-session'
import type { ProviderCredentials } from './types'

/** ChatGPT's OSS flow requires a loopback listener and native credential storage. */
export const canConnectChatGPT = () => isTauri() && !isMobile()

/** Validate identity independently from the separate permission to use the account’s plan. */
export const validateChatGPTIdentity = async (
  idToken: string,
  jwks: JSONWebKeySet,
  clientId: string,
  nonce: string,
  subject?: string,
) => {
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: chatGPTIssuer,
    audience: clientId,
    requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    algorithms: ['RS256'],
  })
  if (payload.nonce !== nonce || !payload.sub || (subject && payload.sub !== subject)) {
    throw new Error('ChatGPT account did not match this sign-in')
  }
  if (
    (payload.azp && payload.azp !== clientId) ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
  ) {
    throw new Error('ChatGPT identity has another authorized party')
  }
  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  }
}

/** Signs in using OpenAI's public OSS client registration, without borrowing another application's client ID. */
export const connectChatGPT = async (
  db: AnyDrizzleDatabase,
  signal: AbortSignal,
  platform?: Partial<OpenRouterAuthDependencies>,
  accountClientId?: string | null,
): Promise<ProviderCredentials> => {
  if (!platform && !canConnectChatGPT()) {
    throw new Error('ChatGPT sign-in requires the desktop app')
  }
  const attempt = await getProviderConnectionAttempt(db, 'openai')
  const metadata = await loadChatGPTMetadata(signal)
  const registration = await readChatGPTRegistration(db, accountClientId)
  const hostKey = 'thunderbolt.chatgpt.host-id'
  const hostId = localStorage.getItem(hostKey) ?? `urn:uuid:${crypto.randomUUID()}`
  localStorage.setItem(hostKey, hostId)
  const nonce = generateCodeVerifier()
  const auth = createProviderAuthorization(
    {
      authorizationEndpoint: metadata.authorization_endpoint,
      loopbackHostname: '127.0.0.1',
      buildUrl: (challenge, redirectUri, state) => {
        const url = new URL(metadata.authorization_endpoint)
        url.search = new URLSearchParams({
          client_id: registration?.clientId ?? 'dynamic_agent_client',
          ext_agent_host_id: hostId,
          ...(registration ? {} : { agent_name_hint: 'Thunderbolt' }),
          ...(registration?.idToken ? { id_token_hint: registration.idToken } : {}),
          ...(registration?.subject && !hasChatGPTPlanScope(registration.scope) ? { prompt: 'consent' } : {}),
          response_type: 'code',
          redirect_uri: redirectUri,
          resource: chatGPTResource,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          state,
          nonce,
          code_challenge_method: 'S256',
          code_challenge: challenge,
        }).toString()
        return url.href
      },
    },
    platform,
  )
  const callback = await auth.startConnection({ signal })
  const clientId = callback.clientId ?? registration?.clientId
  if (!clientId || clientId === 'dynamic_agent_client' || (registration && clientId !== registration.clientId)) {
    throw new Error('Invalid ChatGPT client registration')
  }
  await retainChatGPTRegistration(db, { clientId }, attempt, signal)
  signal.throwIfAborted()
  // Finish a started grant exchange so cancellation can revoke the returned refresh token.
  const tokens = oauthTokensSchema.extend({ id_token: z.string().min(1), expires_in: z.number().positive() }).parse(
    await http
      .post(metadata.token_endpoint, {
        fetch: nativeFetch,
        redirect: 'error',
        credentials: 'omit',
        signal: createOAuthRequestSignal(),
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code: callback.code,
          code_verifier: callback.verifier,
          redirect_uri: callback.redirectUri,
          resource: chatGPTResource,
        }),
      })
      .json(),
  )
  const credentials: ProviderCredentials = {
    reauth_required: !hasChatGPTPlanScope(tokens.scope),
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    oauth: {
      issuer: chatGPTIssuer,
      clientId,
      tokenEndpoint: metadata.token_endpoint,
      resource: chatGPTResource,
      idToken: tokens.id_token,
      scope: tokens.scope,
    },
  }
  try {
    signal.throwIfAborted()
    const jwks = await http
      .get(metadata.jwks_uri, {
        fetch: nativeFetch,
        redirect: 'error',
        credentials: 'omit',
        signal: createOAuthRequestSignal(signal),
      })
      .json<JSONWebKeySet>()
    const identity = await validateChatGPTIdentity(tokens.id_token, jwks, clientId, nonce, registration?.subject)
    await retainChatGPTRegistration(db, { clientId, ...identity }, attempt, signal)
    return { ...credentials, oauth: { ...credentials.oauth!, ...identity } }
  } catch (error) {
    await discardChatGPTAuthorization(db, credentials)
    throw error
  }
}

/** The caller can explain that OpenAI could not confirm revocation without exposing transport details. */
export class ChatGPTCleanupError extends Error {}

/** Revoke only an issued grant that never became the active session, including cancelled saves. */
export const discardChatGPTAuthorization = (db: AnyDrizzleDatabase, credentials: ProviderCredentials) =>
  withProviderOAuthLock('oauth:openai', async () => {
    const row = await db.select().from(secrets).where(eq(secrets.id, 'oauth:openai')).get()
    const current = JSON.parse(row?.credentials ?? '{}') as ProviderCredentials
    // A successful save may already have rotated its refresh token before a later UI/cache failure.
    if (
      current.oauth?.clientId === credentials.oauth?.clientId &&
      ((credentials.oauth?.idToken && current.oauth?.idToken === credentials.oauth.idToken) ||
        (credentials.refresh_token && current.refresh_token === credentials.refresh_token))
    ) {
      return
    }
    try {
      await revokeChatGPTSession(credentials)
    } catch {
      throw new ChatGPTCleanupError('Could not revoke the unused ChatGPT session')
    }
  })
