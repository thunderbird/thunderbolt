/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import postgres from 'postgres'
import { appOrigin, backendUrl, databaseUrl } from './config'

/** The fixed sign-in code a NODE_ENV=test backend accepts (backend/src/auth/otp-constants.ts). */
const testSignInCode = '12345678'

export type ApiResult<T = unknown> = { status: number; body: T; headers: Headers }

/** Call the backend's `/v1` API with optional headers, as the app would. */
export const request = async <T = unknown>(
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<ApiResult<T>> => {
  const response = await fetch(`${backendUrl}/v1${path}`, {
    method,
    redirect: 'manual',
    headers: {
      Origin: appOrigin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const parsed = text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
  return { status: response.status, body: parsed as T, headers: response.headers }
}

/** A client that sends one set of credentials on every call. */
export const asCaller = (headers: Record<string, string>) => ({
  get: <T = unknown>(path: string) => request<T>('GET', path, { headers }),
  post: <T = unknown>(path: string, body?: unknown) => request<T>('POST', path, { headers, body }),
  put: <T = unknown>(path: string, body?: unknown) => request<T>('PUT', path, { headers, body }),
  delete: <T = unknown>(path: string) => request<T>('DELETE', path, { headers }),
})

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

/**
 * Sign in by email code, as the app's email step does: ask for a code, then send the fixed test
 * code. Waits out the per-address cooldown when the code was asked for moments ago.
 */
export const signInByEmailCode = async (email: string) => {
  for (let attempt = 0; ; attempt++) {
    const join = await request<{ challengeToken?: string }>('POST', '/waitlist/join', { body: { email } })
    if (join.status === 429 && attempt < 2) {
      await Bun.sleep(16_000)
      continue
    }
    const signIn = await request<{ code?: string }>('POST', '/api/auth/sign-in/email-otp', {
      headers: join.body.challengeToken ? { 'x-challenge-token': join.body.challengeToken } : {},
      body: { email, otp: testSignInCode },
    })
    return { status: signIn.status, body: signIn.body, bearer: signIn.headers.get('set-auth-token') }
  }
}

/** The session a set of credentials holds, or null when the backend treats it as signed out. */
export const sessionUser = async (headers: Record<string, string>) =>
  (await request<{ user?: { id: string } } | null>('GET', '/api/auth/get-session', { headers })).body?.user?.id ?? null

/**
 * Access to the stack's database, for what no API exposes. One pool for every suite in the run, so
 * suites never close it; idle connections time out and let the process exit.
 */
export const sql = postgres(databaseUrl, { max: 2, idle_timeout: 2, onnotice: () => {} })

export const userByEmail = async (email: string) =>
  (
    await sql<{ id: string; name: string; email: string }[]>`select id, name, email from "user" where email = ${email}`
  )[0] ?? null

/** A user's `scim` membership sources, with the connection each belongs to. */
export const scimSourcesOf = (userId: string) =>
  sql<{ connectionId: string; status: string }[]>`
    select s.identity_connection_id as "connectionId", s.status
    from membership_source s join org_membership m on m.id = s.membership_id
    where m.user_id = ${userId} and s.kind = 'scim'
    order by s.identity_connection_id`

/** The SCIM user a connection holds for a Keycloak user, by its externalId. */
export const scimUserOf = async (identityConnectionId: string, externalId: string) =>
  (
    await sql<{ id: string; userId: string; userName: string; active: boolean }[]>`
      select u.id, u.user_id as "userId", u.user_name as "userName", u.active
      from scim_user u join identity_connection c on c.scim_connection_id = u.connection_id
      where c.id = ${identityConnectionId} and u.external_id = ${externalId}`
  )[0] ?? null

export const closeDatabase = () => sql.end()
