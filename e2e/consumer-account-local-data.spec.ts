/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { expect, test as baseTest, type Page } from './test'
import { collectPageErrors, enterEmailCode, loginViaEmailCode, openSidebarOnMobile, sendChatPrompt } from './helpers'

// THU-963: data left on the device by one account must never reach another account in the same profile.

type Export = { user: { email: string | null }; tables: { mcp_servers: unknown[]; mcp_secrets: unknown[] } }

const serverName = 'THU963 synthetic A'
const mcpUrl = 'http://127.0.0.1:39999/mcp'

/**
 * A context route misses SharedWorker fetches, so the browser itself also refuses to resolve any
 * host name except this machine's. Nothing in this spec can reach a real origin, whichever context
 * makes the request.
 */
const test = baseTest.extend({
  launchOptions: [
    async ({ launchOptions }, use) =>
      use({
        ...launchOptions,
        args: [
          ...(launchOptions.args ?? []),
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
        ],
      }),
    { scope: 'worker' },
  ],
})

// Most tests here sign in three times, and signing the same address in again waits out the backend's OTP
// cooldown, so a slow runner (macOS WebKit) takes 51 to 59 s of the 60 s default.
test.describe.configure({ timeout: 120_000 })

const isOffMachine = (url: URL) => !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)

/**
 * Nothing in this spec may reach a real origin, Tinfoil's attestation service included (system-model
 * prewarm calls it from the page). Every off-machine request from any tab is answered here: Tinfoil
 * with a local 503, everything else aborted. `seen` and `answered` let each test prove none slipped by.
 */
const offMachine = { seen: [] as string[], answered: [] as string[] }

test.beforeEach(async ({ context }) => {
  offMachine.seen = []
  offMachine.answered = []
  context.on('request', (request) => {
    if (isOffMachine(new URL(request.url()))) {
      offMachine.seen.push(request.url())
    }
  })
  await context.route(isOffMachine, (route) => {
    offMachine.answered.push(route.request().url())
    return new URL(route.request().url()).hostname === 'atc.tinfoil.sh'
      ? route.fulfill({ status: 503, json: { error: 'Attestation is answered locally in this spec' } })
      : route.abort('blockedbyclient')
  })
})

test.afterEach(() => {
  expect(offMachine.seen.filter((url) => !offMachine.answered.includes(url))).toEqual([])
  console.warn(`[THU-963] off-machine requests answered locally: ${JSON.stringify(offMachine.answered)}`)
})

/** Import one inert MCP server carrying a synthetic bearer through Connections → Advanced (JSON). */
const importMcpBearer = async (page: Page, token: string) => {
  await page.goto('/settings/connections')
  await page.getByRole('button', { name: 'New Connection' }).click()
  await page.getByRole('button', { name: 'MCP server' }).click()
  await page.getByText('Advanced (JSON)', { exact: true }).click()
  await page.getByLabel('Servers JSON').fill(
    JSON.stringify({
      mcpServers: {
        [serverName]: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
      },
    }),
  )
  await page.getByRole('button', { name: 'Import Servers' }).click()
  await expect(page.getByText(serverName, { exact: true })).toBeVisible()
}

const logOut = async (page: Page, option: 'keep' | 'delete') => {
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('button', { name: 'Log out' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Leave data on device', { exact: true })).toBeVisible()
  if (option === 'delete') {
    await dialog.getByText('Delete data from device', { exact: true }).click()
  }
  await dialog.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByPlaceholder('Email', { exact: true })).toBeVisible({ timeout: 30_000 })
}

/** Runs "Export My Data" and parses the file. The file holds the bearer, so it is read here and not kept. */
const exportData = async (page: Page): Promise<{ payload: Export; raw: string }> => {
  // In-app navigation: a page load would itself move a stale tab onto the signed-in account's slot.
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const download = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Export Your Data' }).click()
  const raw = await readFile(await (await download).path(), 'utf8')
  return { payload: JSON.parse(raw) as Export, raw }
}

/** A finds its server and credential again, in Connections and in the export. */
const expectAllOfA = async (page: Page, emailA: string, token: string) => {
  await page.goto('/settings/connections')
  await expect(page.getByText(serverName, { exact: true })).toBeVisible({ timeout: 30_000 })
  const { payload, raw } = await exportData(page)
  expect(payload.user.email).toBe(emailA)
  expect(payload.tables.mcp_servers).toHaveLength(1)
  expect(payload.tables.mcp_secrets).toHaveLength(1)
  expect(raw).toContain(token)
}

/** B sees neither A's server nor its credential, in Connections or in the export. */
const expectNothingOfA = async (page: Page, emailB: string, token: string, { navigate = true } = {}) => {
  if (navigate) {
    await page.goto('/settings/connections')
  }
  await expect(page.getByRole('button', { name: 'New Connection' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(serverName, { exact: true })).toBeHidden()
  const { payload, raw } = await exportData(page)
  expect(payload.user.email).toBe(emailB)
  expect(payload.tables.mcp_servers).toEqual([])
  expect(payload.tables.mcp_secrets).toEqual([])
  expect(raw).not.toContain(token)
}

/**
 * Cookie-only SSO sends other tabs no token event. Swallow the bearer's, so a tab learns of another
 * account only from the ownership record (`thunderbolt_local_data`), as an SSO tab would.
 */
const actLikeSsoTab = (page: Page) =>
  page.addInitScript(() => {
    window.addEventListener('storage', (event) => {
      if (event.key === 'thunderbolt_auth_token') {
        event.stopImmediatePropagation()
      }
    })
  })

for (const option of ['keep', 'delete'] as const) {
  test(`data left on the device stays with its account, or is gone after deleting (${option})`, async ({ page }) => {
    const errors = collectPageErrors(page)
    const token = `synthetic-${crypto.randomUUID()}`
    const emailA = await loginViaEmailCode(page)
    await importMcpBearer(page, token)
    await logOut(page, option)

    // The sign-in switches the device to B's own slot, then reloads.
    const emailB = await loginViaEmailCode(page)
    await expectNothingOfA(page, emailB, token)
    await logOut(page, 'keep')

    await loginViaEmailCode(page, emailA)
    await page.goto('/settings/connections')
    if (option === 'keep') {
      await expect(page.getByText(serverName, { exact: true })).toBeVisible({ timeout: 30_000 })
    } else {
      await expectNothingOfA(page, emailA, token, { navigate: false })
    }
    expect(errors).toEqual([])
  })
}

test('a magic link switches accounts without redeeming its code twice', async ({ page }) => {
  await loginViaEmailCode(page)
  await logOut(page, 'keep')
  const email = `e2e-${crypto.randomUUID()}@thunderbolt.test`
  await page.getByPlaceholder('Email', { exact: true }).fill(email)
  const requested = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/waitlist/join')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const { challengeToken } = (await (await requested).json()) as { challengeToken: string }

  const redemptions: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/api/auth/sign-in/email-otp') {
      redemptions.push(request.url())
    }
  })
  const redeemed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/v1/api/auth/sign-in/email-otp',
  )
  await page.goto(`/auth/verify?${new URLSearchParams({ email, otp: '12345678', challengeToken })}`)
  expect((await redeemed).status()).toBe(200)
  await expect(page.locator('textarea')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/chats\/new$/)
  expect(redemptions).toHaveLength(1)
})

// Without OPFS, Chromium and Firefox persist each slot in IndexedDB. WebKit keeps it in memory per tab.
test.describe('without OPFS', () => {
  // Three sign-ins with a second app tab open run close to the 60 s default on a CI runner.
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ page }) => {
    // The persistent WebKit page fixture clears OPFS before this hook disables it.
    await page.context().addInitScript(() => {
      // The app's OPFS probe checks for this method.
      delete (StorageManager.prototype as { getDirectory?: unknown }).getDirectory
    })
  })

  /** A second tab on A's data, which never hears of a token change. */
  const openKeeperTab = async (page: Page) => {
    const keeper = await page.context().newPage()
    await actLikeSsoTab(keeper)
    await keeper.goto('/settings/connections')
    await expect(keeper.getByText(serverName, { exact: true })).toBeVisible({ timeout: 30_000 })
    return keeper
  }

  test('A’s data stays A’s through A → B → A with a tab kept open, and B never sees it', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'WebKit without OPFS keeps a separate in-memory database in each tab')
    const token = `synthetic-${crypto.randomUUID()}`
    const emailA = await loginViaEmailCode(page)
    await importMcpBearer(page, token)
    await openKeeperTab(page)

    await logOut(page, 'keep')
    const emailB = await loginViaEmailCode(page)
    await expectNothingOfA(page, emailB, token)
    await logOut(page, 'keep')

    await loginViaEmailCode(page, emailA)
    await expectAllOfA(page, emailA, token)
  })

  test('deleting data leaves nothing of A for B, or for A, even with another tab open', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'WebKit without OPFS keeps a separate in-memory database in each tab')
    const token = `synthetic-${crypto.randomUUID()}`
    const emailA = await loginViaEmailCode(page)
    await importMcpBearer(page, token)
    await openKeeperTab(page)

    await logOut(page, 'delete')
    const emailB = await loginViaEmailCode(page)
    await expectNothingOfA(page, emailB, token)
    await logOut(page, 'keep')

    // A finds nothing either, so the data was deleted from the device.
    await loginViaEmailCode(page, emailA)
    await expectNothingOfA(page, emailA, token)
  })

  test('WebKit keeps local data in its tab and loses it on reload', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'webkit', 'Other browsers persist the fallback database in IndexedDB')
    const token = `synthetic-${crypto.randomUUID()}`
    const email = await loginViaEmailCode(page)
    await importMcpBearer(page, token)

    const other = await context.newPage()
    await other.goto('/settings/connections')
    await expectNothingOfA(other, email, token, { navigate: false })
    await expect(page.getByText(serverName, { exact: true })).toBeVisible()

    await page.reload()
    await expectNothingOfA(page, email, token, { navigate: false })
  })
})

/** Expires the cached session, so only the server can say who is signed in. */
const expireSessionCopy = (page: Page) =>
  page.evaluate(() => {
    const cached = JSON.parse(localStorage.getItem('thunderbolt_session_cache') ?? 'null')
    cached.session.expiresAt = new Date(Date.now() - 60_000).toISOString()
    localStorage.setItem('thunderbolt_session_cache', JSON.stringify(cached))
  })

/** Matches requests to the backend, which runs on a different origin from the page. */
const isBackendOf = (page: Page) => {
  const appOrigin = new URL(page.url()).origin
  return (url: URL) => url.origin !== appOrigin && url.pathname.startsWith('/v1/')
}

const waitingMessage = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Waiting for a spark… Thunderbolt opens on its own.' })

test('offline with an expired session copy, the app says it waits and opens on the same chat once the network is back', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')
  await sendChatPrompt(page, 'A chat to come back to')
  await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible({ timeout: 30_000 })
  const chatUrl = page.url()
  expect(chatUrl).toMatch(/\/chats\/[0-9a-f-]{36}$/)

  await expireSessionCopy(page)
  // Block only the backend for the reload. Going offline would also cut off the dev server that serves the page.
  const isBackend = isBackendOf(page)
  await context.route(isBackend, (route) => route.abort('internetdisconnected'))
  await page.reload()
  const waiting = waitingMessage(page)
  await expect(waiting).toBeVisible({ timeout: 30_000 })
  // Behind the message is a picture of the layout, hidden from screen readers and inert.
  const layoutSkeleton = page.getByTestId('app-layout-skeleton')
  await expect(layoutSkeleton).toBeVisible()
  await expect(layoutSkeleton).toHaveAttribute('inert', '')
  await expect(layoutSkeleton).toHaveAttribute('aria-hidden', 'true')
  await expect(layoutSkeleton).toHaveText('')
  await page.waitForLoadState('networkidle')
  await context.setOffline(true)

  // No part of the app is there to click or type into, and no keyboard shortcut opens anything.
  await page.mouse.click(640, 600)
  await page.keyboard.type('typed while offline')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.locator('textarea')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(waiting).toBeVisible()

  // The network comes back, and its `online` event makes Better Auth request the session again.
  await context.unroute(isBackend)
  await context.setOffline(false)
  await expect(waiting).toBeHidden({ timeout: 30_000 })
  await expect(layoutSkeleton).toHaveCount(0)
  expect(page.url()).toBe(chatUrl)
  // The prompt is saved before the reply streams. The reply's last words can still be unsaved at the reload.
  await expect(page.getByText('A chat to come back to', { exact: true })).toBeVisible()
  const composer = page.locator('textarea')
  await expect(composer).toHaveValue('')
  await composer.fill('Back online')
  await expect(composer).toHaveValue('Back online')
  expect(errors).toEqual([])
})

test('online with the server down, the app asks again on its own and opens once the server answers', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)
  await expireSessionCopy(page)
  const isBackend = isBackendOf(page)
  await context.route(isBackend, (route) => route.abort('connectionrefused'))
  // Time runs as usual until the test moves it forward, so the 30-second retry needs no real wait.
  await page.clock.install()
  await page.reload()
  const waiting = waitingMessage(page)
  await expect(waiting).toBeVisible({ timeout: 30_000 })

  // The server is back, and the device never went offline, so no `online` event comes.
  await context.unroute(isBackend)
  await page.clock.fastForward('00:31')
  await expect(waiting).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('textarea')).toBeVisible()
  expect(errors).toEqual([])
})

test('a tab still showing A’s data leaves it when another tab signs B in', async ({ page, context }) => {
  await actLikeSsoTab(page)
  const token = `synthetic-${crypto.randomUUID()}`
  await loginViaEmailCode(page)
  await importMcpBearer(page, token)

  const other = await context.newPage()
  await other.goto('/')
  await expect(other.locator('textarea')).toBeVisible({ timeout: 30_000 })
  await logOut(other, 'keep')
  await expect(page.getByText(serverName, { exact: true })).toBeVisible()
  const emailB = await loginViaEmailCode(other)

  // Without being navigated, the first tab drops A's connections and exports only B's data.
  await expect(page.getByText(serverName, { exact: true })).toBeHidden({ timeout: 30_000 })
  await expectNothingOfA(page, emailB, token, { navigate: false })
})

test('a tab reloading while another removes A’s keys opens nothing until B’s data is ready', async ({
  page,
  context,
}) => {
  await actLikeSsoTab(page)
  // An SSO tab whose session is not cached yet only learns who is signed in from `/get-session`.
  await page.addInitScript(() => localStorage.removeItem('thunderbolt_session_cache'))
  const token = `synthetic-${crypto.randomUUID()}`
  await loginViaEmailCode(page)
  await importMcpBearer(page, token)

  const other = await context.newPage()
  await other.goto('/')
  await expect(other.locator('textarea')).toBeVisible({ timeout: 30_000 })
  await logOut(other, 'keep')

  // Hold the key-store lock from a same-origin page that runs no app code, so B's cleanup of A's
  // keys stalls after the switch is recorded.
  const holder = await context.newPage()
  await holder.goto('/favicon.svg')
  const releaseKeyStore = await holder.evaluateHandle(
    () =>
      new Promise<() => void>((held) => {
        void navigator.locks.request(
          'thunderbolt-account-key-store',
          () => new Promise<void>((release) => held(release)),
        )
      }),
  )
  // Any use of A's MCP credential from the old tab goes through the proxy to A's server.
  const usesOfA: string[] = []
  page.on('request', (request) => {
    if (request.headers()['x-proxy-target-url'] === mcpUrl) {
      usesOfA.push(request.url())
    }
  })
  const emailB = await enterEmailCode(other)

  // The old tab reloads and waits. While the cleanup runs it opens no slot and shows neither the app nor anything of A.
  await expect(page.getByText(serverName, { exact: true })).toBeHidden({ timeout: 30_000 })
  for (let check = 0; check < 10; check++) {
    await expect(page.getByText(serverName, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Preferences', exact: true })).toHaveCount(0)
    await page.waitForTimeout(500)
  }

  expect(usesOfA).toEqual([])

  await releaseKeyStore.evaluate((release) => release())
  await expectNothingOfA(page, emailB, token, { navigate: false })
  expect(usesOfA).toEqual([])
})
