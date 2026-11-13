/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTinfoilAttestationRequest } from './tinfoil-isolation'
import { defaultModelDeepSeekV41Flash, defaultModelOpus55, defaultModelsVersion } from '../shared/defaults/models'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'
import { expect, test, type Page } from './test'

/** Seed a deployment whose selected model does not use a confidential SDK. */
const useStandardDefault = async (page: Page) => {
  await page.route('**/v1/config', async (route) => {
    const response = await route.fetch()
    const config = (await response.json()) as { defaults?: Record<string, unknown> }
    await route.fulfill({
      response,
      json: {
        ...config,
        defaults: {
          ...config.defaults,
          models: { version: defaultModelsVersion + 1, data: [defaultModelOpus55] },
        },
      },
    })
  })
}

// Mock only the vendor adapter. The real shared cache, client state machine,
// provider binding, store, and responsive attestation UI remain under test.
const privatemodeFixtureAdapter = `
  import { AttestedTransportClient } from '/src/attestation/client.ts';
  export class AttestedPrivatemodeClient {
    static async create(options, reporter, timeoutMs) {
      return new AttestedTransportClient({
        provider: 'Privatemode',
        baseURL: 'https://api.privatemode.example/v1',
        reuseVerification: true,
        verify: async (signal) => {
          const response = await fetch('/__e2e_privatemode_verification', { signal });
          if (!response.ok) throw new Error('Test verifier rejected the deployment');
          return { value: {}, evidence: await response.json(), expiresAt: Date.now() + 60_000 };
        },
        fetch: async () => { throw new Error('Inference is outside this UI fixture'); },
        close: () => {},
        isVerificationFailure: () => true,
      }, reporter, timeoutMs);
    }
  }
`

test('keeps both confidential SDKs unloaded for ordinary chat and settings navigation', async ({ page }) => {
  const errors = collectPageErrors(page)
  const sdkRequests: string[] = []
  page.on('request', (request) => {
    if (
      /\/src\/attestation\/(?:tinfoil|privatemode)\.ts|\/node_modules\/(?:\.vite\/deps\/)?(?:tinfoil|privatemode-ai)[/_.?-]|privatemode\.wasm/.test(
        request.url(),
      )
    ) {
      sdkRequests.push(request.url())
    }
  })
  await useStandardDefault(page)
  await loginViaEmailCode(page)
  await expect(page.getByTestId('model-selector-trigger')).toContainText(defaultModelOpus55.name)
  await page.goto('/settings/connections')
  await expect(page.getByRole('button', { name: 'New Connection', exact: true })).toBeVisible()
  await page.goto('/settings/models')
  await expect(page.getByRole('button', { name: 'New Model', exact: true })).toBeVisible()
  await page.goto('/chats/new')
  await expect(page.getByTestId('model-selector-trigger')).toContainText(defaultModelOpus55.name)
  expect(sdkRequests).toEqual([])
  expect(errors).toEqual([])
})

test('loads the real Privatemode WASM before chat, rejects invalid evidence, and preserves sending', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('The Privatemode SDK browser check needs a local Vite origin')
  }
  const errors = collectPageErrors(page)
  const origin = new URL(baseURL).origin
  const externalRequests: string[] = []
  const wasmResponses: number[] = []
  page.on('response', (response) => {
    if (response.headers()['content-type']?.startsWith('application/wasm')) {
      wasmResponses.push(response.status())
    }
  })
  // Run the genuine verifier with locally supplied invalid evidence. No request
  // reaches a provider, and no real account or API key is needed for this check.
  await page.route(
    (url) => url.protocol === 'https:' && url.origin !== origin,
    async (route) => {
      externalRequests.push(route.request().url())
      await route.fulfill({
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '{invalid deployment evidence',
      })
    },
  )
  await page.route('**/__e2e_privatemode_sdk', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Privatemode SDK browser check</title>',
      headers: { 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Opener-Policy': 'same-origin' },
    }),
  )
  await page.goto('/__e2e_privatemode_sdk')
  const result = await page.evaluate(async () => {
    const modulePath = '/src/attestation/privatemode.ts'
    const { AttestedPrivatemodeClient } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('../src/attestation/privatemode')
    const states: string[] = []
    try {
      const client = await AttestedPrivatemodeClient.create(
        { apiKey: 'e2e-invalid-evidence-key' },
        { publish: (state) => states.push(state.status), close: () => {} },
        15_000,
      )
      await client.close()
      return { created: true, states, error: '' }
    } catch (error) {
      return { created: false, states, error: error instanceof Error ? error.message : String(error) }
    }
  })
  expect(wasmResponses).toEqual([200])
  // The manifest request happens only after the downloaded, hash-checked WASM
  // verifier has instantiated successfully and begun executing.
  expect(externalRequests.length).toBeGreaterThan(0)
  expect(result.created).toBe(false)
  expect(result.states).toEqual(['verifying', 'failed'])
  expect(result.error).toMatch(/invalid|parse|manifest/i)

  const chat = await page.evaluate(async () => {
    // The genuine Go runtime installs a partial process global. Exercise the
    // send path before Pi has had a chance to fill in its missing fields.
    const scope = globalThis as unknown as { process?: { env?: unknown } }
    const goProcess = scope.process
    const hasGoProcess = goProcess !== undefined
    const hasGoEnv = goProcess?.env !== undefined
    const budgetPath = '/src/ai/web-tool-budget.ts'
    const { createWebToolBudget } = (await import(
      /* @vite-ignore */ budgetPath
    )) as typeof import('../src/ai/web-tool-budget')
    const beforePi = createWebToolBudget('auto')
    beforePi.promote('research')

    const corePath = '/shared/agent-core/index.ts'
    const { buildAppHarness, removeAgentWorkspace } = (await import(
      /* @vite-ignore */ corePath
    )) as typeof import('../shared/agent-core/index')
    const afterPi = createWebToolBudget('auto')
    afterPi.promote('research')
    const requests: string[] = []
    const threadId = crypto.randomUUID()
    const harness = await buildAppHarness({
      model: {
        kind: 'openai-compat',
        providerId: 'privatemode',
        modelId: 'gpt-oss-120b',
        baseURL: 'https://api.privatemode.ai/v1',
        apiKey: 'test-placeholder',
        reasoning: false,
        supportsImages: false,
        fetch: async (_input, init) => {
          requests.push(String(init?.body))
          return new Response(
            [
              'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"role":"assistant","content":"hello after attestation"},"finish_reason":null}]}',
              'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
              'data: [DONE]',
              '',
            ].join('\n\n'),
            { headers: { 'Content-Type': 'text/event-stream' } },
          )
        },
      },
      systemPrompt: 'Answer briefly.',
      thinkingLevel: 'off',
      threadId,
    })
    try {
      const reply = await harness.prompt('hello after loading Privatemode')
      return {
        hasGoProcess,
        hasGoEnv,
        preservedProcess: scope.process === goProcess,
        promotedCaps: [beforePi.cap, afterPi.cap],
        requests,
        stopReason: reply.stopReason,
        content: reply.content,
      }
    } finally {
      await removeAgentWorkspace(threadId)
    }
  })
  expect(chat.hasGoProcess).toBe(true)
  expect(chat.hasGoEnv).toBe(false)
  expect(chat.preservedProcess).toBe(true)
  expect(chat.promotedCaps).toEqual([30, 30])
  expect(chat.requests).toHaveLength(1)
  expect(JSON.parse(chat.requests[0])).toMatchObject({ model: 'gpt-oss-120b', stream: true })
  expect(chat.requests[0]).toContain('hello after loading Privatemode')
  expect(chat.stopReason).toBe('stop')
  expect(chat.content).toEqual([{ type: 'text', text: 'hello after attestation' }])
  expect(errors).toEqual([])
})

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`connection privacy at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('uses the shared Privatemode dialog for idle, verification failure, retry, and verified policy details', async ({
      page,
    }) => {
      const errors = collectPageErrors(page)
      const attempts: Array<(succeeded: boolean) => void> = []
      const adapters: string[] = []
      await page.route(
        (url) => url.pathname === '/src/attestation/privatemode.ts',
        async (route) => {
          adapters.push(route.request().url())
          await route.fulfill({ contentType: 'application/javascript', body: privatemodeFixtureAdapter })
        },
      )
      await page.route('**/__e2e_privatemode_verification', async (route) => {
        const attempt = Promise.withResolvers<boolean>()
        attempts.push(attempt.resolve)
        const succeeded = await attempt.promise
        await route.fulfill({
          status: succeeded ? 200 : 503,
          json: {
            provider: 'Privatemode',
            verifiedAt: Date.now(),
            endpoint: 'coordinator.privatemode.example',
            checks: ['hardware', 'policy', 'channel'],
            details: [
              { label: 'manifest', value: 'test-verified-manifest-digest' },
              { label: 'policy', value: 'test-verified-policy-hash' },
            ],
          },
        })
      })
      await useStandardDefault(page)
      const email = await loginViaEmailCode(page)
      const connectionId = crypto.randomUUID()
      await importBackup(page, {
        format: 'thunderbolt-export',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        user: { id: 'attestation-fixture', email },
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
              credentials: JSON.stringify({ apiKey: 'test-attestation-key' }),
            },
          ],
          models: [
            {
              id: crypto.randomUUID(),
              provider: 'privatemode',
              providerConnectionId: connectionId,
              name: 'Private model fixture',
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
      const selector = page.getByTestId('model-selector-trigger')
      await selector.click()
      await page.getByRole('button', { name: 'Private model fixture Privatemode', exact: true }).click()
      await expect(selector).toContainText('Private model fixture')
      await page.keyboard.press('Escape')
      await selector.click()
      await page.getByRole('button', { name: 'Private inference', exact: true }).click()
      const modal = page.getByRole('dialog')
      await expect(modal.getByRole('heading', { name: 'Private inference', exact: true })).toBeVisible()
      await expect(modal.getByText(/before sending to Privatemode/)).toBeVisible()
      expect(adapters).toEqual([])

      try {
        await modal.getByRole('button', { name: 'Verify connection', exact: true }).click()
        await expect(modal.getByRole('heading', { name: 'Verifying connection…', exact: true })).toBeVisible()
        await expect.poll(() => attempts.length).toBe(1)
        expect(adapters).toHaveLength(1)
        attempts[0](false)
        await expect(modal.getByRole('heading', { name: 'Verification failed', exact: true })).toBeVisible()
        await expect(modal.getByText('Connection details', { exact: true })).toHaveCount(0)
        await modal.getByRole('button', { name: 'Try again', exact: true }).click()
        await expect(modal.getByRole('heading', { name: 'Verifying connection…', exact: true })).toBeVisible()
        await expect.poll(() => attempts.length).toBe(2)
        attempts[1](true)
        await expect(modal.getByRole('heading', { name: 'Connection Verified', exact: true })).toBeVisible()
        await expect(modal.getByText(/verified Privatemode's confidential inference endpoint/)).toBeVisible()
        await expect(modal.getByText('Hardware attestation', { exact: true })).toBeVisible()
        await expect(modal.getByText('Verified deployment policy', { exact: true })).toBeVisible()
        await expect(modal.getByText('Enclave-bound encryption key', { exact: true })).toBeVisible()
        await expect(modal.getByText('Signed build provenance', { exact: true })).toHaveCount(0)
        await modal.getByText('Connection details', { exact: true }).click()
        await expect(modal.getByText('Deployment manifest digest', { exact: true })).toBeVisible()
        await expect(modal.getByText('test-verified-manifest-digest', { exact: true })).toBeVisible()
        await expect(modal.getByText('Deployment policy hashes', { exact: true })).toBeVisible()
        await expect(modal.getByText('test-verified-policy-hash', { exact: true })).toBeVisible()
        await expect(modal.getByText(/Connected tools and external services/)).toBeVisible()
        await modal.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(modal).toBeHidden()
        if (viewport.width >= 768) {
          await expect(selector).toBeFocused()
        }
        expect(errors).toEqual([])
      } finally {
        attempts.forEach((resolve) => resolve(false))
      }
    })

    test('opens privacy above effort, retries failed verification, and closes back to the selector', async ({
      page,
    }) => {
      const errors = collectPageErrors(page)
      let attestationRequests = 0
      await page.route(isTinfoilAttestationRequest, async (route) => {
        attestationRequests += 1
        await route.fulfill({ status: 503, json: { error: 'Test attestation unavailable' } })
      })
      await loginViaEmailCode(page)

      const selector = page.getByTestId('model-selector-trigger')
      await selector.click()
      const privateModel = page.getByRole('button', {
        name: `${defaultModelDeepSeekV41Flash.name} Thunderbolt`,
        exact: true,
      })
      await expect(privateModel.getByRole('img', { name: 'Thunderbolt', exact: true })).toBeVisible()
      await expect(privateModel.getByLabel('Private', { exact: true })).toHaveCount(0)
      await expect(privateModel.getByText('Private', { exact: true })).toHaveCount(0)
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
      const standardModel = page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true })
      await expect(standardModel.getByRole('img', { name: 'Thunderbolt', exact: true })).toBeVisible()
      await standardModel.click()
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
