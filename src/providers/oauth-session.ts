/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, exists, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { providerConnectionsTable as connections, providerConnectionSecretsTable as secrets } from '@/db/tables'
import { http, HttpError } from '@/lib/http'
import { nativeFetch as desktopFetch } from '@/lib/native-fetch'
import { searchOAuthFetch } from './mcp-search-auth'
import { createOAuthRequestSignal } from '@/lib/openrouter-auth'
import { providerCredentialConnected } from './credentials'
import type { ProviderCredentials } from './types'
import { getIdentitySignal } from '@/lib/identity-lifetime'

export const oauthTokensSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
})

/** A signed-in account must separately grant permission to spend its ChatGPT plan. */
export const hasChatGPTPlanScope = (scope: string | undefined): boolean =>
  scope?.split(' ').includes('chatgpt.tokens.use.direct') ?? false

const terminalRefreshErrors = new Set([
  'invalid_grant',
  'invalid_client',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])
const oauthErrorSchema = z.object({ error: z.string() })

/** Serializes rotating refresh tokens across tabs and desktop windows. */
export const withProviderOAuthLock = <T>(id: string, action: () => Promise<T>): Promise<T> =>
  navigator.locks.request(`provider-oauth:${id}`, () => action())

/** Refreshes only the still-enabled, locally approved session; late results never restore disconnected access. */
export const resolveOAuthAccessToken = (db: AnyDrizzleDatabase, id: string): Promise<string> => {
  const signal = getIdentitySignal()
  return withProviderOAuthLock(id, async () => {
    signal.throwIfAborted()
    const row = await db
      .select({ credentials: secrets.credentials })
      .from(connections)
      .innerJoin(secrets, eq(secrets.id, connections.id))
      .where(and(eq(connections.id, id), eq(connections.enabled, 1), providerCredentialConnected))
      .get()
    signal.throwIfAborted()
    if (!row?.credentials) {
      throw new Error('Reconnect this provider')
    }
    const current = JSON.parse(row.credentials) as ProviderCredentials
    if (!current.access_token || !current.oauth) {
      throw new Error('OAuth session is incomplete')
    }
    if (current.expires_at === undefined || current.expires_at > Date.now() + 60_000) {
      return current.access_token
    }
    const save = (next: ProviderCredentials) =>
      db.transaction(async (tx) => {
        signal.throwIfAborted()
        const active = tx
          .select({ id: connections.id })
          .from(connections)
          .where(
            and(
              eq(connections.id, id),
              eq(connections.enabled, 1),
              isNull(connections.deletedAt),
              providerCredentialConnected,
            ),
          )
        const updated = await tx
          .update(secrets)
          .set({ credentials: JSON.stringify(next) })
          .where(and(eq(secrets.id, id), eq(secrets.credentials, row.credentials!), exists(active)))
          .returning({ id: secrets.id })
        signal.throwIfAborted()
        if (!updated.length) {
          throw new Error('OAuth connection changed during refresh')
        }
      })
    if (!current.refresh_token) {
      await save({ ...current, reauth_required: true })
      throw new Error('Reconnect this provider')
    }
    try {
      const tokens = oauthTokensSchema.parse(
        await http
          .post(current.oauth.tokenEndpoint, {
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: current.refresh_token,
              client_id: current.oauth.clientId,
              resource: current.oauth.resource,
            }),
            fetch: id === 'oauth:openai' ? desktopFetch : searchOAuthFetch(),
            redirect: 'error',
            credentials: 'omit',
            signal: createOAuthRequestSignal(signal),
          })
          .json(),
      )
      const scope = tokens.scope ?? current.oauth.scope
      const reauthRequired = id === 'oauth:openai' && !hasChatGPTPlanScope(scope)
      await save({
        ...current,
        oauth: { ...current.oauth, scope },
        reauth_required: reauthRequired,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? current.refresh_token,
        expires_at: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
      })
      if (reauthRequired) {
        throw new Error('ChatGPT plan access was not authorized; reconnect this provider')
      }
      return tokens.access_token
    } catch (error) {
      if (error instanceof HttpError && error.response.status >= 400 && error.response.status < 500) {
        const body = oauthErrorSchema.safeParse(await error.response.json().catch(() => null))
        if (body.success && terminalRefreshErrors.has(body.data.error)) {
          await save({ ...current, reauth_required: true })
        }
      }
      throw error
    }
  })
}
