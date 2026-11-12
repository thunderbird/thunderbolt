/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { verifySignedBearerToken } from '@/auth/bearer-token'
import type { Settings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { account as accountTable, session as sessionTable } from '@/db/auth-schema'
import { verification } from '@/db/schema'
import { safeErrorHandler } from '@/middleware/error-handling'
import { resolveAppName } from '@shared/branding'
import { and, eq, gt } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { configuredSsoProviderId } from './paths'

const callbackScheme = 'net.thunderbird.thunderbolt.native'
const callbackHost = 'sso-callback'
const nonceCookieName = 'thunderbolt_native_sso_nonce'
const codeLifetimeMs = 2 * 60 * 1000
const stateSchema = t.String({ pattern: '^[A-Za-z0-9_-]{43,128}$' })
const challengeSchema = t.String({ pattern: '^[A-Za-z0-9_-]{43}$' })

const callbackState = (secret: string, nonce: string, state: string, challenge: string): string =>
  createHmac('sha256', secret)
    .update(JSON.stringify([nonce, state, challenge]))
    .digest('base64url')

const matches = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

const cookieValue = (header: string, name: string): string | undefined => {
  for (const item of header.split(';')) {
    const [key, ...value] = item.split('=')
    if (key.trim() === name) {
      return value.join('=').trim()
    }
  }
  return undefined
}

const sessionCookie = (header: string): string | undefined =>
  cookieValue(header, '__Secure-better-auth.session_token') ?? cookieValue(header, 'better-auth.session_token')

const codeIdentifier = (code: string): string =>
  `native-sso-code-${createHash('sha256').update(code).digest('base64url')}`
const stateIdentifier = (state: string): string =>
  `native-sso-state-${createHash('sha256').update(state).digest('base64url')}`

const verifierChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')

const nativeErrorPage = (appName: string) =>
  new Response(
    `<html><head><meta charset="utf-8"><title>${Bun.escapeHTML(appName)}</title></head><body><h2>${Bun.escapeHTML(appName)}</h2><p>Unable to start sign-in. Close this window and try again.</p></body></html>`,
    { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )

/** Native SSO uses a browser-owned cookie session and redeems a one-use PKCE code over TLS. */
export const createSsoNativeCallbackRoutes = (
  settings: Settings,
  database: typeof DbType,
  fetchFn: typeof fetch = globalThis.fetch,
) => {
  if (settings.authMode === 'consumer') {
    return new Elysia({ prefix: '/api/auth/sso' })
  }

  return new Elysia({ prefix: '/api/auth/sso' })
    .onError(safeErrorHandler)
    .get(
      '/native-initiate',
      async ({ query, request }) => {
        const baseURL = settings.betterAuthUrl.replace(/\/$/, '')
        const nonce = randomBytes(32).toString('base64url')
        const binding = callbackState(settings.betterAuthSecret, nonce, query.state, query.code_challenge)
        const stateID = stateIdentifier(query.state)
        const previousSession = sessionCookie(request.headers.get('cookie') ?? '')
        let previousToken: string | null = null
        try {
          if (previousSession) {
            previousToken = decodeURIComponent(previousSession)
          }
        } catch {
          previousToken = previousSession ?? null
        }
        const startedAt = Date.now()
        await database
          .insert(verification)
          .values({
            id: stateID,
            identifier: stateID,
            value: JSON.stringify({
              nonce,
              state: query.state,
              challenge: query.code_challenge,
              startedAt,
              previousTokenHash: previousToken ? createHash('sha256').update(previousToken).digest('base64url') : null,
            }),
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          })
          .onConflictDoNothing()
        const callbackURL = new URL(`${baseURL}/v1/api/auth/sso/native-callback`)
        callbackURL.searchParams.set('state', query.state)
        callbackURL.searchParams.set('code_challenge', query.code_challenge)
        callbackURL.searchParams.set('callback_state', binding)

        const response = await fetchFn(`${baseURL}/v1/api/auth/sign-in/sso`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: configuredSsoProviderId,
            callbackURL: callbackURL.href,
            errorCallbackURL: callbackURL.href,
          }),
        })
        if (!response.ok) {
          return nativeErrorPage(resolveAppName(settings.branding))
        }
        const result = (await response.json()) as { url?: unknown }
        const loginURL = typeof result.url === 'string' && URL.canParse(result.url) ? new URL(result.url) : null
        if (
          !loginURL ||
          !['https:', 'http:'].includes(loginURL.protocol) ||
          loginURL.username ||
          loginURL.password ||
          loginURL.hash
        ) {
          return nativeErrorPage(resolveAppName(settings.branding))
        }

        const headers = new Headers({
          location: loginURL.href,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        for (const cookie of response.headers.getSetCookie()) {
          headers.append('set-cookie', cookie)
        }
        const isSecure = request.url.startsWith('https:') || request.headers.get('x-forwarded-proto') === 'https'
        headers.append(
          'set-cookie',
          `${nonceCookieName}=${nonce}; HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=600${isSecure ? '; Secure' : ''}`,
        )
        return new Response(null, { status: 302, headers })
      },
      { query: t.Object({ state: stateSchema, code_challenge: challengeSchema }) },
    )
    .get(
      '/native-callback',
      async ({ request, query }) => {
        const cookieHeader = request.headers.get('cookie') ?? ''
        const nonce = cookieValue(cookieHeader, nonceCookieName)
        if (
          !nonce ||
          !matches(
            query.callback_state,
            callbackState(settings.betterAuthSecret, nonce, query.state, query.code_challenge),
          )
        ) {
          return new Response('Invalid SSO callback. Restart sign-in from the app.', { status: 403 })
        }
        const states = await database
          .delete(verification)
          .where(eq(verification.identifier, stateIdentifier(query.state)))
          .returning()
        const stateEntry = states[0]
        const stateBinding =
          stateEntry &&
          (JSON.parse(stateEntry.value) as {
            nonce?: unknown
            state?: unknown
            challenge?: unknown
            startedAt?: unknown
            previousTokenHash?: unknown
          })
        if (
          !stateEntry ||
          stateEntry.expiresAt <= new Date() ||
          stateBinding?.nonce !== nonce ||
          stateBinding.state !== query.state ||
          stateBinding.challenge !== query.code_challenge
        ) {
          return new Response('SSO request has expired. Restart sign-in from the app.', { status: 403 })
        }

        const redirect = (parameters: Record<string, string>) => {
          const url = new URL(`${callbackScheme}://${callbackHost}`)
          for (const [key, value] of Object.entries(parameters)) {
            url.searchParams.set(key, value)
          }
          return new Response(null, {
            status: 302,
            headers: [
              ['location', url.href],
              ['set-cookie', `${nonceCookieName}=; HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=0`],
              ['cache-control', 'no-store'],
              ['referrer-policy', 'no-referrer'],
            ],
          })
        }

        if (query.error) {
          return redirect({ state: query.state, error: query.error })
        }
        const encodedToken = sessionCookie(cookieHeader)
        if (!encodedToken) {
          return redirect({ state: query.state, error: 'session_not_found' })
        }

        const code = randomBytes(32).toString('base64url')
        let signedToken: string
        try {
          signedToken = decodeURIComponent(encodedToken)
        } catch {
          return redirect({ state: query.state, error: 'session_not_found' })
        }
        const rawToken = verifySignedBearerToken(signedToken, settings.betterAuthSecret)
        const previousTokenHash = stateBinding?.previousTokenHash
        const currentTokenHash = createHash('sha256').update(signedToken).digest('base64url')
        const startedAt = typeof stateBinding?.startedAt === 'number' ? stateBinding.startedAt : NaN
        if (
          !rawToken ||
          !Number.isFinite(startedAt) ||
          (typeof previousTokenHash === 'string' && matches(previousTokenHash, currentTokenHash))
        ) {
          return redirect({ state: query.state, error: 'session_not_created' })
        }
        const activeSessions = await database
          .select({ createdAt: sessionTable.createdAt, userId: sessionTable.userId })
          .from(sessionTable)
          .where(and(eq(sessionTable.token, rawToken), gt(sessionTable.expiresAt, new Date())))
          .limit(1)
        if (!activeSessions[0] || activeSessions[0].createdAt.getTime() < startedAt) {
          return redirect({ state: query.state, error: 'session_not_created' })
        }
        const linkedSsoAccounts = await database
          .select({ id: accountTable.id })
          .from(accountTable)
          .where(
            and(
              eq(accountTable.userId, activeSessions[0].userId),
              eq(accountTable.providerId, configuredSsoProviderId),
            ),
          )
          .limit(1)
        if (!linkedSsoAccounts[0]) {
          return redirect({ state: query.state, error: 'sso_account_missing' })
        }
        await database.insert(verification).values({
          id: crypto.randomUUID(),
          identifier: codeIdentifier(code),
          value: JSON.stringify({ token: signedToken, state: query.state, challenge: query.code_challenge }),
          expiresAt: new Date(Date.now() + codeLifetimeMs),
        })
        return redirect({ state: query.state, code })
      },
      {
        query: t.Object({
          state: stateSchema,
          code_challenge: challengeSchema,
          callback_state: t.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
          error: t.Optional(t.String()),
        }),
      },
    )
    .post(
      '/native-token',
      async ({ body, set }) => {
        set.headers['cache-control'] = 'no-store'
        set.headers.pragma = 'no-cache'
        const identifier = codeIdentifier(body.code)
        const rows = await database.delete(verification).where(eq(verification.identifier, identifier)).returning()
        const entry = rows[0]
        if (!entry || entry.expiresAt <= new Date()) {
          set.status = 401
          return { error: 'invalid_or_expired_code' }
        }
        const binding = JSON.parse(entry.value) as { token?: unknown; state?: unknown; challenge?: unknown }
        if (
          typeof binding.token !== 'string' ||
          binding.state !== body.state ||
          typeof binding.challenge !== 'string' ||
          !matches(binding.challenge, verifierChallenge(body.code_verifier))
        ) {
          set.status = 401
          return { error: 'invalid_or_expired_code' }
        }
        return { token: binding.token }
      },
      {
        body: t.Object({
          code: t.String({ minLength: 32, maxLength: 128 }),
          state: stateSchema,
          code_verifier: t.String({ pattern: '^[A-Za-z0-9._~-]{43,128}$' }),
        }),
      },
    )
}
