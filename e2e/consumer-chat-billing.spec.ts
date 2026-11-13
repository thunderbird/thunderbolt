/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectPageErrors, loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'
import { expect, test } from './test'

const billingMessage =
  'The AI provider requires billing setup or additional credits. Check your provider account before retrying.'

// Replace only the vendor transport; real Pi, chat state, and error UI consume
// the HTTP response exactly as they would a decrypted SDK response.
const fixtureAdapter = `
  import { AttestedTransportClient } from '/src/attestation/client.ts';
  export class AttestedPrivatemodeClient {
    static async create(options, reporter, timeoutMs) {
      const client = new AttestedTransportClient({
        provider: 'Privatemode',
        baseURL: 'https://api.privatemode.ai/v1',
        reuseVerification: true,
        verify: async () => ({
          value: {},
          evidence: {
            provider: 'Privatemode', verifiedAt: Date.now(), endpoint: 'api.privatemode.ai',
            checks: ['hardware', 'policy', 'channel'], details: [],
          },
          expiresAt: Date.now() + 60_000,
        }),
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.method === 'GET') return Response.json({ object: 'list', data: [] });
          return fetch('/__e2e_privatemode_chat', {
            method: 'POST', body: await request.text(), signal: request.signal,
          });
        },
        close: () => {},
        isVerificationFailure: () => false,
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
  test.describe(`provider billing error at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('explains a 402 without automatic retries and lets the user retry after resolving billing', async ({
      page,
    }) => {
      const errors = collectPageErrors(page)
      const requests: string[] = []
      const billing = { ready: false }
      await page.route(
        (url) => url.pathname === '/src/attestation/privatemode.ts',
        (route) => route.fulfill({ contentType: 'application/javascript', body: fixtureAdapter }),
      )
      await page.route('**/__e2e_privatemode_chat', async (route) => {
        requests.push(route.request().postData() ?? '')
        if (!billing.ready) {
          await route.fulfill({
            status: 402,
            json: { error: { message: 'Quota locked until a payment card is added.', type: 'billing_error' } },
          })
          return
        }
        await route.fulfill({
          contentType: 'text/event-stream',
          body: [
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello after resolving billing."},"finish_reason":null}]}',
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
        })
      })
      const email = await loginViaEmailCode(page)
      const connectionId = crypto.randomUUID()
      await importBackup(page, {
        format: 'thunderbolt-export',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        user: { id: 'billing-fixture', email },
        tables: {
          provider_connections: [
            {
              id: connectionId,
              provider: 'privatemode',
              name: 'Privatemode',
              authMethod: 'api_key',
              url: null,
              enabled: 1,
            },
          ],
          provider_connection_secrets: [
            {
              id: connectionId,
              binding: JSON.stringify(['privatemode', 'api_key', null]),
              credentials: JSON.stringify({ apiKey: 'test-billing-key' }),
            },
          ],
          models: [
            {
              id: crypto.randomUUID(),
              provider: 'privatemode',
              providerConnectionId: connectionId,
              name: 'Private billing fixture',
              model: 'gpt-oss-120b',
              enabled: 1,
              isSystem: 0,
              isConfidential: 1,
              toolUsage: 1,
            },
          ],
        },
      })
      await page.goto('/chats/new')
      await page.getByTestId('model-selector-trigger').click()
      await page.getByRole('button', { name: 'Private billing fixture Privatemode', exact: true }).click()
      await page.keyboard.press('Escape')
      await page.locator('textarea').fill('Please greet me briefly.')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()

      await expect(page.getByText(billingMessage, { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
      await expect(page.getByText(/Something went wrong/)).toHaveCount(0)
      expect(requests).toHaveLength(1)

      billing.ready = true
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(page.locator('[data-quotable-message-id]').last()).toContainText('Hello after resolving billing.')
      await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
      await expect(page.getByText(billingMessage, { exact: true })).toHaveCount(0)
      expect(requests).toHaveLength(2)
      expect(errors).toEqual([])
    })
  })
}
