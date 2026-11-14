/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { normalizeEmail } from '@/lib/email'
import { extractClientIp } from '@/utils/request'
import { isAPIError } from 'better-auth/api'
import type { AuthAdapter } from './access'
import { type AuditEventInput, createAuditEvent } from './audit/write'
import { deviceTokenPath, getSsoConnection, otpSignInPath, passkeySignInPath, ssoSignInPaths } from './sign-in'
import { findSsoConnection } from './sso-connections'

/** Paths that mint a session for a sign-in. */
export const signInPaths = new Set([otpSignInPath, ...ssoSignInPaths, passkeySignInPath, deviceTokenPath])

export type SignInMethod = 'email_code' | 'passkey' | 'oidc' | 'saml' | 'device_grant'

const methodByPath: Record<string, SignInMethod> = {
  [otpSignInPath]: 'email_code',
  [passkeySignInPath]: 'passkey',
  [deviceTokenPath]: 'device_grant',
  '/sso/callback/:providerId': 'oidc',
  '/sso/callback': 'oidc',
  '/sso/saml2/sp/acs/:providerId': 'saml',
}

/** The device grant answers these while the CLI polls; they are not failed sign-ins. */
const devicePollingErrors = new Set(['authorization_pending', 'slow_down'])

/** Error codes come from Better Auth or, on SSO redirects, the IdP: keep only code-shaped ones. */
const safeCode = (value: unknown) => {
  const code = typeof value === 'string' ? value.trim().replace(/\s+/g, '_') : ''
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'UNKNOWN'
}

type SignInEventInput = {
  outcome: 'success' | 'failure'
  path: string
  headers: Headers | undefined
  userId?: string | null
  reason?: string | null
  connectionId?: string | null
  sessionId?: string
}

/**
 * An `auth.sign_in` event. Sign-in events are the only ones that carry the client's IP and user
 * agent. Nothing from the attempt itself is kept beyond ids: no address, code or assertion.
 */
export const signInEvent = ({
  outcome,
  path,
  headers = new Headers(),
  userId = null,
  reason = null,
  connectionId = null,
  sessionId,
}: SignInEventInput): AuditEventInput => ({
  action: 'auth.sign_in',
  outcome,
  reason,
  actor: { type: 'user', id: userId },
  target: { type: 'user', id: userId },
  connectionId,
  metadata: { method: methodByPath[path] ?? null, ...(sessionId ? { sessionId } : {}) },
  ipAddress: extractClientIp(headers, '', getSettings().trustedProxy) || null,
  userAgent: headers.get('user-agent'),
})

/**
 * Why a sign-in that created no session failed, or null when it was not a failure: the device
 * grant still polling, or a response that is no error at all. SSO callbacks answer every failure
 * with a redirect carrying `error=`; the rest throw an APIError.
 */
export const signInFailureReason = (path: string, returned: unknown): string | null => {
  if (!isAPIError(returned)) {
    return null
  }
  if (returned.statusCode === 302) {
    const location = new Headers(returned.headers as HeadersInit).get('location')
    const error = location ? new URL(location, 'http://localhost').searchParams.get('error') : null
    return error ? safeCode(error) : null
  }
  const body = returned.body as { code?: unknown; error?: unknown } | undefined
  if (path === deviceTokenPath) {
    return devicePollingErrors.has(String(body?.error)) ? null : safeCode(body?.error)
  }
  return safeCode(body?.code ?? body?.error ?? returned.status)
}

/**
 * The user a failed attempt was against, when it names one we know: the address of an email-code
 * attempt, or the credential of a passkey assertion. Null otherwise, so an attempt on an unknown
 * address stores nothing that identifies it.
 */
export const findAttemptedUser = async (adapter: AuthAdapter, path: string, body: unknown) => {
  if (path === otpSignInPath) {
    const email = (body as { email?: unknown } | undefined)?.email
    if (typeof email !== 'string') {
      return null
    }
    const row = await adapter.findOne<{ id: string }>({
      model: 'user',
      where: [{ field: 'email', value: normalizeEmail(email) }],
    })
    return row?.id ?? null
  }
  if (path === passkeySignInPath) {
    const credentialId = (body as { response?: { id?: unknown } } | undefined)?.response?.id
    if (typeof credentialId !== 'string') {
      return null
    }
    const row = await adapter.findOne<{ userId: string }>({
      model: 'passkey',
      where: [{ field: 'credentialID', value: credentialId }],
    })
    return row?.userId ?? null
  }
  return null
}

/** What a sign-in endpoint's hooks see of the request. */
type SignInContext = {
  path: string
  headers?: Headers
  body?: unknown
  params?: unknown
}

/**
 * Record a failed sign-in through `adapter`, which must not be the failed attempt's own
 * transaction. `userId` is set when the refusal already knows the user; otherwise the attempt's
 * address or passkey names one, if any. The connection is the one the SSO sign-in came through.
 */
export const recordFailedSignIn = async (
  adapter: AuthAdapter,
  ctx: SignInContext,
  reason: string,
  userId?: string | null,
) => {
  const providerId = (ctx.params as { providerId?: unknown } | undefined)?.providerId
  const connectionId =
    (await getSsoConnection())?.id ??
    (typeof providerId === 'string' ? (await findSsoConnection(adapter, providerId))?.id : undefined)
  await createAuditEvent(
    adapter,
    signInEvent({
      outcome: 'failure',
      path: ctx.path,
      headers: ctx.headers,
      userId: userId ?? (await findAttemptedUser(adapter, ctx.path, ctx.body)),
      reason,
      connectionId,
    }),
  )
}

/**
 * Record a refusal a before-hook is about to throw, and return it for the throw. A before-hook's
 * throw skips every after-hook, so the identity plugin's sign-in audit never sees it. Off a
 * sign-in path, this records nothing.
 */
export const refuseSignIn = async <E>(
  adapter: AuthAdapter,
  ctx: Omit<SignInContext, 'path'> & { path?: string },
  error: E,
) => {
  const reason = ctx.path && signInPaths.has(ctx.path) ? signInFailureReason(ctx.path, error) : null
  if (ctx.path && reason) {
    await recordFailedSignIn(adapter, { ...ctx, path: ctx.path }, reason)
  }
  return error
}
