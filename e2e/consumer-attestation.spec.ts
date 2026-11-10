/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelOpus55 } from '../shared/defaults/models'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { expect, test } from './test'

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`connection privacy at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('opens privacy above effort, retries failed verification, and closes back to the selector', async ({
      page,
    }) => {
      const errors = collectPageErrors(page)
      let attestationRequests = 0
      await page.route('https://atc.tinfoil.sh/attestation', async (route) => {
        attestationRequests += 1
        await route.fulfill({ status: 503, json: { error: 'Test attestation unavailable' } })
      })
      await loginViaEmailCode(page)

      const selector = page.getByTestId('model-selector-trigger')
      await selector.click()
      const privacyRow = page.getByRole('button', { name: 'Verification failed', exact: true })
      await expect(privacyRow).toBeVisible()
      const requestsAfterPrewarm = attestationRequests
      await privacyRow.click()

      const modal = page.getByRole('dialog', { name: 'Verification failed', exact: true })
      await expect(modal).toBeVisible()
      await expect(modal.getByRole('heading')).toHaveCount(1)
      await expect(modal.getByRole('heading', { name: 'Verification failed' }).locator('svg')).toBeVisible()
      await expect(selector).toHaveAttribute('aria-expanded', 'false')
      await expect(modal.getByRole('heading', { name: 'Verification failed' })).toBeVisible()
      await expect(modal.getByText('Connection details', { exact: true })).toHaveCount(0)
      await expect(modal.getByText(/Connected tools and external services/)).toBeVisible()
      expect(attestationRequests).toBe(requestsAfterPrewarm)

      await modal.getByRole('button', { name: 'Try again' }).click()
      await expect.poll(() => attestationRequests).toBeGreaterThan(requestsAfterPrewarm)
      await expect(modal.getByRole('heading', { name: 'Verification failed' })).toBeVisible()
      await modal.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(modal).toBeHidden()
      if (viewport.width >= 768) {
        await expect(selector).toBeFocused()
      }

      await selector.click()
      await page.getByRole('button', { name: defaultModelOpus55.name, exact: true }).click()
      await expect(
        page.getByRole('button', { name: /Verification failed|Connection verified|Private inference/ }),
      ).toHaveCount(0)
      expect(errors).toEqual([])
    })
  })
}

test('an ACP agent explains its own boundary without inheriting the local model verification', async ({ page }) => {
  const errors = collectPageErrors(page)
  await page.route('**/v1/agents', (route) =>
    route.fulfill({
      json: {
        version: '1',
        agents: [
          {
            id: 'privacy-test-agent',
            name: 'Privacy test agent',
            type: 'managed-acp',
            transport: 'websocket',
            url: 'wss://attestation-agent.example/ws',
            description: 'Attestation boundary test',
            icon: null,
            isSystem: 1,
          },
        ],
        allowCustomAgents: true,
      },
    }),
  )
  await page.routeWebSocket('wss://attestation-agent.example/ws', (socket) => {
    socket.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { id: number; method: string }
      const result =
        request.method === 'initialize'
          ? { protocolVersion: 1, agentCapabilities: {} }
          : { sessionId: 'privacy-test-session' }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  await loginViaEmailCode(page)
  await page.getByTestId('agent-selector-trigger').click()
  await page.getByRole('button', { name: 'Privacy test agent', exact: true }).click()
  await page.getByRole('button', { name: 'Connection privacy: Agent privacy', exact: true }).click()

  const modal = page.getByRole('dialog', { name: 'Agent privacy', exact: true })
  await expect(modal).toBeVisible()
  await expect(
    modal.getByText(/Privacy test agent receives this chat and manages its own model connection/),
  ).toBeVisible()
  await expect(modal.getByText(/This device has not verified the agent/)).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Verify connection' })).toHaveCount(0)
  await expect(modal.getByRole('heading', { name: 'Connection Verified', exact: true })).toHaveCount(0)
  await expect(modal.getByText('Connection details', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})
