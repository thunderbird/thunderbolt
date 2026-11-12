/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectPageErrors, loginViaEmailCode } from './helpers'
import { expect, test, type Page } from './test'

/** Inspect real local rows, including credentials that would be orphaned by an early save. */
const privatemodePersistence = (page: Page) =>
  page.evaluate(async () => {
    const databasePath = '/src/db/database.ts'
    const tablesPath = '/src/db/tables.ts'
    const { getDb } = (await import(/* @vite-ignore */ databasePath)) as typeof import('../src/db/database')
    const { providerConnectionsTable, providerConnectionSecretsTable } = (await import(
      /* @vite-ignore */ tablesPath
    )) as typeof import('../src/db/tables')
    const db = getDb()
    const connections = (await db.select().from(providerConnectionsTable)).filter(
      ({ provider }) => provider === 'privatemode',
    )
    const secrets = (await db.select().from(providerConnectionSecretsTable)).filter(
      ({ binding }) => binding && (JSON.parse(binding) as string[])[0] === 'privatemode',
    )
    return {
      names: connections.map(({ name }) => name),
      apiKeys: secrets.map(({ credentials }) => (JSON.parse(credentials ?? '{}') as { apiKey?: string }).apiKey),
    }
  })

// Keep the real shared transport, validation, form, and DAL. Only the
// vendor's verified transport is replaced with a local authentication endpoint.
const fixtureAdapter = `
  import { AttestedTransportClient } from '/src/attestation/client.ts';
  import { asAttestationFailure } from '/src/attestation/errors.ts';
  export class AttestedPrivatemodeClient {
    static async create(options, reporter, timeoutMs) {
      const authenticate = (signal) => fetch('/__e2e_privatemode_auth', {
        signal,
        headers: { Authorization: 'Bearer ' + options.apiKey },
      });
      const client = new AttestedTransportClient({
        provider: 'Privatemode',
        baseURL: 'https://api.privatemode.ai/v1',
        reuseVerification: true,
        verify: async (signal) => {
          if (options.apiKey === 'test-rejected-initialization-key') {
            const response = await authenticate(signal);
            await response.json();
            if (!response.ok) {
              throw new Error('SDK initialization failed', {
                cause: Object.assign(new Error('Unauthorized'), { status: response.status }),
              });
            }
          }
          return {
            value: {},
            evidence: {
              provider: 'Privatemode', verifiedAt: Date.now(), endpoint: 'api.privatemode.ai',
              checks: ['hardware', 'policy', 'channel'], details: [],
            },
            expiresAt: Date.now() + 60_000,
          };
        },
        fetch: async (input, init) => authenticate(init?.signal),
        close: () => {},
        isVerificationFailure: () => false,
        normalizeFailure: asAttestationFailure,
      }, reporter, timeoutMs);
      await client.ensureVerified();
      return client;
    }
  }
`

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`Privatemode connection at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('validates the API key before saving, rejects a wrong key, and accepts a corrected retry', async ({
      page,
    }) => {
      const errors = collectPageErrors(page)
      const sdkRequests: string[] = []
      const attempts: Array<{ authorization?: string; release: () => void }> = []
      page.on('request', (request) => {
        if (/privatemode-ai|\/attestation\/privatemode\.ts|privatemode\.wasm/.test(request.url())) {
          sdkRequests.push(request.url())
        }
      })
      await page.route(
        (url) => url.pathname === '/src/attestation/privatemode.ts',
        (route) => route.fulfill({ contentType: 'application/javascript', body: fixtureAdapter }),
      )
      await page.route('**/__e2e_privatemode_auth', async (route) => {
        const gate = Promise.withResolvers<void>()
        const authorization = route.request().headers().authorization
        attempts.push({ authorization, release: gate.resolve })
        await gate.promise
        const valid = authorization === 'Bearer test-valid-private-key'
        await route.fulfill({
          status: valid ? 200 : 401,
          json: valid ? { object: 'list', data: [] } : { error: { message: 'Invalid API key' } },
        })
      })
      await loginViaEmailCode(page)
      await page.goto('/settings/connections')
      await page.getByRole('button', { name: 'New Connection', exact: true }).click()
      await page.getByRole('button', { name: 'Privatemode Models', exact: true }).click()
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Privatemode')
      await expect(page.getByLabel('Server URL', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Use sign-in instead' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
      await page.getByLabel('Name', { exact: true }).fill('Private workspace')
      await page.getByLabel('API key', { exact: true }).fill('test-rejected-initialization-key')
      expect(sdkRequests).toEqual([])
      expect(await privatemodePersistence(page)).toEqual({ names: [], apiKeys: [] })
      try {
        for (const [index, key] of ['test-rejected-initialization-key', 'test-rejected-catalog-key'].entries()) {
          await page.getByLabel('API key', { exact: true }).fill(key)
          await page.getByRole('button', { name: 'Continue', exact: true }).click()
          await expect.poll(() => attempts.length).toBe(index + 1)
          expect(sdkRequests).toHaveLength(1)
          expect(attempts[index].authorization).toBe(`Bearer ${key}`)
          await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
          await expect(page.getByLabel('API key', { exact: true })).toBeDisabled()
          expect(await privatemodePersistence(page)).toEqual({ names: [], apiKeys: [] })
          attempts[index].release()
          await expect(page.getByRole('alert')).toHaveText('The API key was rejected. Check it and try again.')
          await expect(page.getByLabel('API key', { exact: true })).toHaveValue(key)
          await expect(page.getByRole('button', { name: 'Disconnect this device', exact: true })).toHaveCount(0)
          expect(await privatemodePersistence(page)).toEqual({ names: [], apiKeys: [] })
        }

        await page.getByLabel('API key', { exact: true }).fill('test-valid-private-key')
        await page.getByRole('button', { name: 'Continue', exact: true }).click()
        await expect.poll(() => attempts.length).toBe(3)
        expect(attempts[2].authorization).toBe('Bearer test-valid-private-key')
        expect(await privatemodePersistence(page)).toEqual({ names: [], apiKeys: [] })
        attempts[2].release()
        await expect(page.getByRole('heading', { name: 'Private workspace', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Disconnect this device', exact: true })).toBeVisible()
        await expect(page.getByLabel('API key', { exact: true })).toHaveCount(0)
        expect(await privatemodePersistence(page)).toEqual({
          names: ['Private workspace'],
          apiKeys: ['test-valid-private-key'],
        })
      } finally {
        attempts.forEach(({ release }) => release())
      }
      expect(errors).toEqual([])
    })
  })
}
