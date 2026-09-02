/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { authHeaders, createTestApp } from '@/test-utils/e2e'
import { clearSettingsCache } from '@/config/settings'
import { user as userTable } from '@/db/auth-schema'
import { devicesTable, waitlist } from '@/db/schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { encryptionMetadataTable } from '@/db/encryption-schema'
import { countActiveDevices } from '@/dal'
import { hashCanarySecret } from '@/lib/canary'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'bun:test'
import { getSharedIsolatedTestDb } from '@/test-utils/db'

const authBaseUrl = 'http://localhost/v1/api/auth'
const canarySecret = 'cli-acceptance-canary-secret'

type DeviceCodeResponse = {
  readonly device_code: string
  readonly user_code: string
}

type DeviceGrantRequestBody =
  | { readonly client_id: string }
  | { readonly userCode: string }
  | {
      readonly grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      readonly device_code: string
      readonly client_id: string
    }

/** Build the minimal usage-bearing OpenAI stream required by the direct inference route. */
const successfulCompletion = (): Response =>
  new Response(
    [
      `data: ${JSON.stringify({
        id: 'chatcmpl-cli-device',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'registered CLI' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'chatcmpl-cli-device',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )

/** Send JSON to one real Better Auth device-grant endpoint. */
const postAuthJson = (
  app: { handle: (request: Request) => Promise<Response> },
  path: string,
  body: DeviceGrantRequestBody,
  headers: Record<string, string> = {},
): Promise<Response> =>
  app.handle(
    new Request(`${authBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )

const originalEnvironment = {
  POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
  TINFOIL_API_KEY: process.env.TINFOIL_API_KEY,
  TINFOIL_ENCLAVE_URL: process.env.TINFOIL_ENCLAVE_URL,
  CLI_DEVICE_REGISTRATION_ENABLED: process.env.CLI_DEVICE_REGISTRATION_ENABLED,
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  clearSettingsCache()
})

describe('CLI device cross-stack acceptance', () => {
  it('revokes a registered device-grant CLI before a second direct provider request', async () => {
    process.env.TINFOIL_API_KEY = 'cli-device-provider-key'
    process.env.TINFOIL_ENCLAVE_URL = 'https://cli-device-provider.example/v1'
    process.env.CLI_DEVICE_REGISTRATION_ENABLED = 'true'
    delete process.env.POSTHOG_API_KEY
    clearSettingsCache()

    const cliDeviceId = `cli-${crypto.randomUUID()}`
    const attemptedNormalDeviceId = crypto.randomUUID()
    const trustedAppId = crypto.randomUUID()
    const providerRequests: Request[] = []
    let acceptanceUserId: string | null = null
    const { db: isolatedDatabase } = await getSharedIsolatedTestDb()
    const harness = await createTestApp({
      database: isolatedDatabase,
      fetchFn: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          providerRequests.push(input instanceof Request ? input.clone() : new Request(input, init))
          return successfulCompletion()
        },
        { preconnect: () => undefined },
      ),
    })

    try {
      const codeResponse = await postAuthJson(harness.app, '/device/code', { client_id: 'thunderbolt-cli' })
      expect(codeResponse.status).toBe(200)
      const code = (await codeResponse.json()) as DeviceCodeResponse

      const approval = await postAuthJson(
        harness.app,
        '/device/approve',
        { userCode: code.user_code },
        authHeaders(harness.bearerToken),
      )
      expect(approval.status).toBe(200)

      const tokenResponse = await postAuthJson(harness.app, '/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: 'thunderbolt-cli',
      })
      expect(tokenResponse.status).toBe(200)
      const cliBearer = tokenResponse.headers.get('set-auth-token')
      expect(cliBearer).toBeString()
      if (!cliBearer) {
        throw new Error('device grant did not expose a signed CLI bearer')
      }

      const registration = await harness.app.handle(
        new Request('http://localhost/v1/account/devices/cli', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${cliBearer}`,
            'X-Device-ID': cliDeviceId,
            'X-Device-Name': 'Acceptance CLI',
            'X-App-Version': '1.0.0-test',
          },
        }),
      )
      expect(registration.status).toBe(200)
      expect(await registration.json()).toEqual({ deviceId: cliDeviceId, state: 'registered' })

      const attemptedRebind = await harness.app.handle(
        new Request('http://localhost/v1/devices', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cliBearer}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            deviceId: attemptedNormalDeviceId,
            publicKey: 'attempted-normal-public-key',
            mlkemPublicKey: 'attempted-normal-mlkem-public-key',
          }),
        }),
      )
      expect(attemptedRebind.status).toBe(409)
      expect(await attemptedRebind.json()).toEqual({ code: 'SESSION_DEVICE_MISMATCH' })
      expect(
        await harness.db.select().from(devicesTable).where(eq(devicesTable.id, attemptedNormalDeviceId)),
      ).toHaveLength(0)
      const [registeredCliDevice] = await harness.db.select().from(devicesTable).where(eq(devicesTable.id, cliDeviceId))
      acceptanceUserId = registeredCliDevice.userId
      expect(await countActiveDevices(harness.db, acceptanceUserId)).toBe(1)

      const directRequest = () =>
        harness.app.handle(
          new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cliBearer}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'deepseek-v4-flash',
              messages: [{ role: 'user', content: 'acceptance request' }],
              stream: true,
            }),
          }),
        )

      const firstInference = await directRequest()
      expect(firstInference.status).toBe(200)
      expect(await firstInference.text()).toContain('registered CLI')
      expect(providerRequests).toHaveLength(1)

      const session = await harness.app.handle(
        new Request(`${authBaseUrl}/get-session`, { headers: authHeaders(harness.bearerToken) }),
      )
      const sessionBody = (await session.json()) as { readonly user: { readonly id: string } }
      acceptanceUserId = sessionBody.user.id
      const now = new Date()
      await harness.db.insert(devicesTable).values({
        id: trustedAppId,
        userId: sessionBody.user.id,
        name: 'Trusted Web App',
        deviceType: 'normal',
        trusted: true,
        approvalPending: false,
        createdAt: now,
        lastSeen: now,
      })
      await harness.db.insert(encryptionMetadataTable).values({
        userId: sessionBody.user.id,
        canaryIv: 'acceptance-iv',
        canaryCtext: 'acceptance-ciphertext',
        canarySecretHash: await hashCanarySecret(canarySecret),
        createdAt: now,
      })

      const revoke = await harness.app.handle(
        new Request(`http://localhost/v1/account/devices/${cliDeviceId}/revoke`, {
          method: 'POST',
          headers: {
            ...authHeaders(harness.bearerToken),
            'Content-Type': 'application/json',
            'X-Device-ID': trustedAppId,
          },
          body: JSON.stringify({ canarySecret }),
        }),
      )
      expect(revoke.status).toBe(204)

      const revokedInference = await directRequest()
      expect(revokedInference.status).toBe(401)
      expect(providerRequests).toHaveLength(1)
    } finally {
      await harness.cleanup()
      if (acceptanceUserId) {
        await harness.db.delete(inferenceUsage).where(eq(inferenceUsage.userId, acceptanceUserId))
      }
      await harness.db.delete(userTable).where(eq(userTable.email, harness.email))
      await harness.db.delete(waitlist).where(eq(waitlist.email, harness.email))
    }

    if (!acceptanceUserId) {
      throw new Error('acceptance user id was not resolved')
    }
    expect(await harness.db.select().from(inferenceUsage).where(eq(inferenceUsage.userId, acceptanceUserId))).toEqual(
      [],
    )
  })
})
