/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Helpers for the admin screens' Playwright specs.
 *
 * - **Naming:** an admin spec is `e2e/admin-<area>.spec.ts`, at the top of `e2e/`. Only the `admin`
 *   (desktop) and `admin-narrow` (400 px) projects run it, against the admin stack in
 *   `playwright.config.ts`: Vite on 1427, an OIDC-mode backend on 8008, and two login-hint IdPs
 *   (`adminIdpUrls`).
 * - **Shared org:** every admin spec, in every worker, runs against the same organization. Use unique
 *   names and emails (`uniqueEmail`, `uniqueName`), never assert global counts or list positions,
 *   and never remove a bootstrap admin, so break-glass never fires by accident.
 * - **Fixtures:** `adminTest` signs this worker's bootstrap admin in once and gives every test a
 *   `page` signed in as that admin, plus `adminApi` to seed data over HTTP.
 */

import { readFile } from 'node:fs/promises'
import { expect, test as base, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import type {
  AdminConnectionDetail,
  AdminMember,
  CreateScimConnectionBody,
  CreateScimConnectionResponse,
  LocalGroup,
  Page as ApiPage,
} from '../../shared/admin-api'
import { openSidebarOnMobile } from '../helpers'
import { adminSpareIdpSecretPrefix, encodeLoginHint, type IdpIdentity } from './mock-idp'

// Matches testSignInOtp in backend/src/auth/otp-constants.ts (NODE_ENV=test only).
const e2eSignInCode = '12345678'

export const adminAppUrl = 'http://localhost:1427'
export const adminBackendUrl = 'http://localhost:8008'

/** The admin backend's API base, for raw requests such as SCIM (`${adminApiBaseUrl}/api/auth/scim/v2/Users`). */
export const adminApiBaseUrl = `${adminBackendUrl}/v1`

/** `env` backs the deployment's `sso` connection; `spare` is free for a spec to register as a new connection. */
export const adminIdpUrls = { env: 'http://localhost:9882', spare: 'http://localhost:9883' }

export const uniqueEmail = (prefix = 'member') => `${prefix}-${crypto.randomUUID()}@thunderbolt.test`

export const uniqueName = (prefix: string) => `${prefix} ${crypto.randomUUID().slice(0, 8)}`

type StorageState = Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['storageState']>>

export type AdminSession = { email: string; token: string; storageState: StorageState }

export type SeededMember = { userId: string; email: string; token: string }

/** The bearer token the app stored after signing in. */
const readStoredToken = (storageState: StorageState) => {
  const entry = storageState.origins
    .find((origin) => origin.origin === adminAppUrl)
    ?.localStorage.find((item) => item.name === 'thunderbolt_auth_token')
  const token = entry && (JSON.parse(entry.value) as { token?: string }).token
  if (!token) {
    throw new Error('Signed in, but the app stored no auth token')
  }
  return token
}

/** The backend refuses a second code for one address within 15 s; past that, it answers again. */
const otpCooldownMs = 15_250

/**
 * Sign in by email code on the SSO deployment's fallback page, then wait for the chat UI. When the
 * address asked for a code moments ago (a worker restarted), wait out the backend's cooldown once.
 */
export const signInByEmailCode = async (page: Page, email: string) => {
  await page.goto('/sign-in/email-code')
  await page.getByPlaceholder('Email', { exact: true }).fill(email)
  const requestCode = async () => {
    const response = page.waitForResponse((res) => new URL(res.url()).pathname === '/v1/waitlist/join')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    return (await response).status()
  }
  if ((await requestCode()) === 429) {
    await page.waitForTimeout(otpCooldownMs)
    expect(await requestCode()).toBe(200)
  }
  await page.locator('input[autocomplete="one-time-code"]').fill(e2eSignInCode)
  await expect(page.locator('textarea')).toBeVisible({ timeout: 30_000 })
}

/** Sign an address in over HTTP, without a browser. */
const signInByApi = async (request: APIRequestContext, email: string): Promise<SeededMember> => {
  const headers = { Origin: adminAppUrl }
  const join = await request.post(`${adminBackendUrl}/v1/waitlist/join`, { data: { email }, headers })
  expect(join.ok()).toBe(true)
  const { challengeToken } = (await join.json()) as { challengeToken?: string }
  expect(challengeToken).toBeTruthy()
  const signIn = await request.post(`${adminBackendUrl}/v1/api/auth/sign-in/email-otp`, {
    data: { email, otp: e2eSignInCode },
    headers: { ...headers, 'x-challenge-token': challengeToken ?? '' },
  })
  expect(signIn.ok()).toBe(true)
  const token = signIn.headers()['set-auth-token']
  const { user } = (await signIn.json()) as { user: { id: string } }
  return { userId: user.id, email, token }
}

/** The admin API over HTTP, as the worker's bootstrap admin. Paths are relative to `/v1/`. */
export const createAdminApiRequest = (request: APIRequestContext, token: string) => {
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
    const response = await request.fetch(`${adminApiBaseUrl}/${path}`, {
      method,
      data: body,
      headers: { Authorization: `Bearer ${token}`, Origin: adminAppUrl },
    })
    if (!response.ok()) {
      throw new Error(`${method} ${path} answered ${response.status()}: ${await response.text()}`)
    }
    return (response.status() === 204 ? undefined : await response.json()) as T
  }

  return {
    request: call,
    /** A new member, signed in by email code over HTTP (open sign-up admits them). */
    seedMember: () => signInByApi(request, uniqueEmail()),
    findMember: async (email: string) => {
      const page = await call<ApiPage<AdminMember>>('GET', `admin/members?q=${encodeURIComponent(email)}`)
      const member = page.items.find((item) => item.email === email)
      if (!member) {
        throw new Error(`No member ${email}`)
      }
      return member
    },
    grantAdmin: (userId: string) => call<AdminMember>('POST', `admin/members/${userId}/roles`, { role: 'admin' }),
    revokeAdmin: (userId: string) => call<AdminMember>('DELETE', `admin/members/${userId}/roles/admin`),
    seedGroup: async ({ name = uniqueName('Group'), memberIds = [] }: { name?: string; memberIds?: string[] } = {}) => {
      const group = await call<LocalGroup>('POST', 'admin/groups', { name })
      for (const userId of memberIds) {
        await call('POST', `admin/groups/${group.id}/members`, { userId })
      }
      return group
    },
    /**
     * An OIDC connection on the spare IdP, which signs in whoever `routeIdpIdentity` names. The IdP
     * accepts only secrets starting with `adminSpareIdpSecretPrefix`.
     */
    seedOidcConnection: ({
      name = uniqueName('IdP'),
      providerId = `idp-${crypto.randomUUID().slice(0, 8)}`,
      clientSecret = `${adminSpareIdpSecretPrefix}${crypto.randomUUID()}`,
    }: { name?: string; providerId?: string; clientSecret?: string } = {}) =>
      call<AdminConnectionDetail>('POST', 'admin/connections/sso', {
        name,
        providerId,
        protocol: { oidc: { issuer: adminIdpUrls.spare, clientId: 'thunderbolt-admin-e2e', clientSecret } },
      }),
    seedScimConnection: (body: CreateScimConnectionBody = { name: uniqueName('SCIM') }) =>
      call<CreateScimConnectionResponse>('POST', 'admin/connections/scim', body),
  }
}

export type AdminApiRequest = ReturnType<typeof createAdminApiRequest>

/** The admin backend's stdout, as `playwright.config.ts` tees it. */
const adminBackendLog = new URL('./backend.log', import.meta.url)

/**
 * The link of the latest invitation to `email`, read from the admin backend's dev log (no email is
 * sent in tests). Waits for the line to appear.
 */
export const readInviteUrl = async (email: string): Promise<string> => {
  const pattern = new RegExp(
    `Invitation URL for ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(no email sent\\): (\\S+)`,
    'g',
  )
  const latest = async () => {
    const log = await readFile(adminBackendLog, 'utf8').catch(() => '')
    return [...log.matchAll(pattern)].at(-1)?.[1] ?? null
  }
  await expect.poll(latest, { message: `an invitation link for ${email}` }).not.toBeNull()
  return (await latest())!
}

/** Make the next IdP sign-in on this page arrive as `identity`. */
export const routeIdpIdentity = async (page: Page, identity: IdpIdentity) => {
  for (const idp of Object.values(adminIdpUrls)) {
    await page.route(`${idp}/authorize*`, (route) => {
      const url = new URL(route.request().url())
      url.searchParams.set('login_hint', encodeLoginHint(identity))
      return route.continue({ url: url.toString() })
    })
  }
}

/** Open the sidebar (a drawer at phone width), then switch it to the Admin section. */
export const openAdminSection = async (page: Page) => {
  await openSidebarOnMobile(page)
  await page.getByRole('navigation', { name: 'Sidebar sections' }).getByRole('button', { name: 'Admin' }).click()
}

/**
 * `page` is signed in as this worker's bootstrap admin (`<adminKey>-<parallelIndex>@thunderbolt.test`,
 * signed in once per worker), and `adminApi` calls the admin API as them. `memberPage` opens a new
 * page signed in as a fresh member, in this project's viewport.
 */
export const adminTest = base.extend<
  { adminApi: AdminApiRequest; memberPage: () => Promise<{ page: Page; email: string; token: string }> },
  { adminSession: AdminSession }
>({
  adminSession: [
    async ({ browser }, use, workerInfo) => {
      const { adminKey } = workerInfo.project.metadata as { adminKey?: string }
      if (!adminKey) {
        throw new Error(`Project ${workerInfo.project.name} has no metadata.adminKey; see playwright.config.ts`)
      }
      // No two workers running at once share a parallelIndex, so the address is this worker's alone.
      const email = `${adminKey}-${workerInfo.parallelIndex}@thunderbolt.test`
      const context = await browser.newContext({ baseURL: adminAppUrl })
      await signInByEmailCode(await context.newPage(), email)
      const storageState = await context.storageState()
      await context.close()
      await use({ email, token: readStoredToken(storageState), storageState })
    },
    { scope: 'worker', timeout: 90_000 },
  ],
  storageState: async ({ adminSession }, use) => {
    await use(adminSession.storageState)
  },
  adminApi: async ({ request, adminSession }, use) => {
    await use(createAdminApiRequest(request, adminSession.token))
  },
  memberPage: async ({ browser, viewport }, use) => {
    const contexts: Awaited<ReturnType<Browser['newContext']>>[] = []
    await use(async () => {
      // The test runner applies the `storageState` fixture (the admin's) to every new context: start empty.
      const context = await browser.newContext({
        baseURL: adminAppUrl,
        viewport,
        storageState: { cookies: [], origins: [] },
      })
      contexts.push(context)
      const page = await context.newPage()
      const email = uniqueEmail()
      await signInByEmailCode(page, email)
      return { page, email, token: readStoredToken(await context.storageState()) }
    })
    await Promise.all(contexts.map((context) => context.close()))
  },
})
