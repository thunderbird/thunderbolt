/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Flow coverage for {@link performLogin} with every dependency injected: the PAT
 * short-circuit, the interactive happy path (persist + QR gate), and the
 * link-only fallback. No real network, timers, or filesystem.
 */

import { describe, expect, it } from 'bun:test'
import { performLogin, type LoginDeps } from './login.ts'
import type { CliAuthConfig } from './token-store.ts'
import type { DeviceCodeResponse, TokenPollResult } from './device-grant.ts'

const code: DeviceCodeResponse = {
  deviceCode: 'dev-code',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://app.test/device',
  verificationUriComplete: 'https://app.test/device?user_code=WDJB-MJHT',
  intervalSeconds: 5,
  expiresInSeconds: 300,
}

/** Build DI deps with sensible defaults, recording every side effect. */
const makeDeps = (overrides: Partial<LoginDeps> = {}) => {
  const printed: string[] = []
  const stored: CliAuthConfig[] = []
  const qrTexts: string[] = []
  const requestCalls = { count: 0 }
  const pollResults: TokenPollResult[] = [{ kind: 'approved', token: 'signed.jwt' }]
  const pollIndex = { count: 0 }

  const deps: LoginDeps = {
    env: { cloudUrl: 'https://api.test/v1' },
    transport: {
      requestCode: async () => {
        requestCalls.count += 1
        return code
      },
      pollToken: async () => {
        const next = pollResults[pollIndex.count]
        pollIndex.count += 1
        return next
      },
    },
    clock: { now: () => 0, sleep: async () => {} },
    storeToken: async (config) => {
      stored.push(config)
    },
    print: (line) => printed.push(line),
    renderQr: (text) => qrTexts.push(text),
    qrEnv: { isTty: true, columns: 120 },
    ...overrides,
  }

  return { deps, printed, stored, qrTexts, requestCalls }
}

describe('performLogin', () => {
  it('uses THUNDERBOLT_TOKEN directly and skips the interactive flow', async () => {
    const { deps, printed, stored, requestCalls } = makeDeps({
      env: { cloudUrl: 'https://api.test/v1', patToken: 'pat-xyz' },
    })

    const token = await performLogin(deps)

    expect(token).toBe('pat-xyz')
    expect(requestCalls.count).toBe(0)
    expect(stored).toEqual([]) // an env PAT is ephemeral — never persisted
    expect(printed.some((line) => line.includes('THUNDERBOLT_TOKEN'))).toBe(true)
  })

  it('runs the device grant, prints the link + code, and persists the token', async () => {
    const { deps, printed, stored, qrTexts } = makeDeps()

    const token = await performLogin(deps)

    expect(token).toBe('signed.jwt')
    expect(stored).toEqual([{ token: 'signed.jwt', cloudUrl: 'https://api.test/v1' }])
    expect(printed.some((line) => line.includes(code.verificationUri) && line.includes(code.userCode))).toBe(true)
    expect(qrTexts).toEqual([code.verificationUriComplete])
  })

  it('prints the link but skips the QR when the terminal cannot render one', async () => {
    const { deps, printed, qrTexts } = makeDeps({ qrEnv: { isTty: false, columns: 120 } })

    await performLogin(deps)

    expect(qrTexts).toEqual([])
    expect(printed.some((line) => line.includes(code.verificationUri))).toBe(true)
  })

  it('refuses the interactive flow over plain http to a remote host', async () => {
    const { deps, stored } = makeDeps({ env: { cloudUrl: 'http://selfhost.example/v1' } })

    const err = await performLogin(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('insecure')
    expect(stored).toEqual([]) // never minted or persisted a token
  })
})
