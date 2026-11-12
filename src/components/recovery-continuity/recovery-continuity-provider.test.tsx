/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createClient, type HttpClient } from '@/lib/http'
import { dispatchRecoveryPhraseChanged } from '@/lib/recovery-phrase-pending'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import type { EncryptionMetadataResponse } from '@shared/e2ee-types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { DeviceKeyTrust } from './recovery-continuity-status'
import { RecoveryContinuityProvider, useRecoveryContinuity } from './recovery-continuity-provider'

const served = (overrides: Partial<EncryptionMetadataResponse> = {}): EncryptionMetadataResponse => ({
  canary_iv: 'iv',
  canary_ctext: 'ct',
  kdf_salt: 'salt',
  signing_public_key: 'spki',
  recovery_ecdh_public_key: 'recovery-ecdh',
  recovery_mlkem_public_key: 'recovery-mlkem',
  recovery_wrapped_ak: 'recovery-envelope',
  recovery_attestation: 'recovery-attestation',
  recovery_continuity: null,
  passkey_credential_id: null,
  passkey_ecdh_public_key: null,
  passkey_mlkem_public_key: null,
  passkey_wrapped_ak: null,
  passkey_attestation: null,
  passkey_continuity: null,
  key_version: 1,
  primary_key_id: '0',
  scheme_version: 2,
  ...overrides,
})

/** A backend whose metadata the test can change between requests, or make fail. */
const createBackend = () => {
  const backend = { metadata: served(), failing: false }
  const httpClient = createClient({
    prefixUrl: 'http://backend.test',
    fetch: async () =>
      backend.failing
        ? new Response(JSON.stringify({ error: 'down' }), { status: 500 })
        : new Response(JSON.stringify(backend.metadata), { headers: { 'Content-Type': 'application/json' } }),
  })
  return { backend, httpClient }
}

const Probe = () => {
  const value = useRecoveryContinuity()
  return (
    <div>
      <p data-testid="status">{value.status}</p>
      <p data-testid="passkey">{value.passkey}</p>
      <p data-testid="notice">{value.notice}</p>
      <button onClick={() => void value.start()}>start phrase</button>
      <button onClick={() => void value.startPasskeyMigration()}>start passkey</button>
    </div>
  )
}

/** Tick the global fake clock until the probe shows `expected`. */
const settleTo = async (testId: string, expected: string) => {
  for (let attempt = 0; attempt < 30 && screen.getByTestId(testId).textContent !== expected; attempt++) {
    await act(async () => {
      // tickAsync, not runAllAsync: the status query's refetch interval repeats forever.
      await getClock().tickAsync(10)
    })
  }
  expect(screen.getByTestId(testId).textContent).toBe(expected)
}

const settle = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    await act(async () => {
      // tickAsync, not runAllAsync: the status query's refetch interval repeats forever.
      await getClock().tickAsync(10)
    })
  }
}

const trusted: DeviceKeyTrust = { ready: true, unverified: false }

const renderProvider = ({
  httpClient,
  trust = () => trusted,
  rotate = mock(async () => 'new phrase'),
  migratePasskey = mock(async () => 'sealed' as const),
}: {
  httpClient: HttpClient
  trust?: () => DeviceKeyTrust
  rotate?: (httpClient: HttpClient, opts: { stepUpOtp: string }) => Promise<string>
  migratePasskey?: () => Promise<'sealed' | 'alreadySealed'>
}) => {
  const wrapper = createTestProvider({
    httpClient,
    authClient: createMockAuthClient({ session: { user: { id: 'user-a', email: 'a@example.test' } } }),
  })
  const Wrapper = wrapper
  render(
    <Wrapper>
      <RecoveryContinuityProvider
        rotate={rotate}
        requestCode={async () => {}}
        readTrust={async () => trust()}
        migratePasskey={migratePasskey}
        readPrf={async () => new Uint8Array(32).fill(5)}
      >
        <Probe />
      </RecoveryContinuityProvider>
    </Wrapper>,
  )
  return { rotate, migratePasskey }
}

/** Drive the phrase flow from the confirm dialog to the submitted code. */
const submitCode = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
  await settle()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '12345678' } })
  await settle()
}

describe('RecoveryContinuityProvider', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    useLocalSettingsStore.getState().setLocalSetting('recoveryContinuityUpdateRequiredFor', null)
  })

  afterEach(() => {
    cleanup()
    useLocalSettingsStore.getState().setLocalSetting('recoveryContinuityUpdateRequiredFor', null)
  })

  it('shows warning for a trusted device on an account without a seal', async () => {
    renderProvider(createBackend())
    await settleTo('status', 'warning')
  })

  it('shows unverified on a marked device', async () => {
    const { backend, httpClient } = createBackend()
    backend.metadata = served({ recovery_continuity: 'sealed' })
    renderProvider({ httpClient, trust: () => ({ ready: true, unverified: true }) })
    await settleTo('status', 'unverified')
  })

  it('reports updatedElsewhere when the seal appears without a local change', async () => {
    const { backend, httpClient } = createBackend()
    renderProvider({ httpClient })
    await settleTo('status', 'warning')

    backend.metadata = served({ recovery_continuity: 'sealed' })
    fireEvent.click(screen.getByRole('button', { name: 'start phrase' }))
    await settleTo('notice', 'updatedElsewhere')
    await settleTo('status', 'hidden')
  })

  it('reports updatedHere after a local phrase change', async () => {
    const { backend, httpClient } = createBackend()
    renderProvider({ httpClient })
    await settleTo('status', 'warning')

    backend.metadata = served({ recovery_continuity: 'sealed' })
    act(() => dispatchRecoveryPhraseChanged())
    await settleTo('notice', 'updatedHere')
  })

  it('keeps the cached warning when the fetch fails', async () => {
    useLocalSettingsStore.getState().setLocalSetting('recoveryContinuityUpdateRequiredFor', 'user-a')
    const { backend, httpClient } = createBackend()
    backend.failing = true
    renderProvider({ httpClient })
    await settle()
    expect(screen.getByTestId('status').textContent).toBe('warning')
    expect(useLocalSettingsStore.getState().recoveryContinuityUpdateRequiredFor).toBe('user-a')
  })

  it('rotates once the code is entered while the update is still needed', async () => {
    const { httpClient } = createBackend()
    const { rotate } = renderProvider({ httpClient })
    await settleTo('status', 'warning')
    fireEvent.click(screen.getByRole('button', { name: 'start phrase' }))
    await settle()

    await submitCode()

    expect(rotate).toHaveBeenCalledTimes(1)
    expect(rotate).toHaveBeenCalledWith(expect.anything(), { stepUpOtp: '12345678' })
  })

  it('does not rotate when the account is sealed by the time the code is entered', async () => {
    const { backend, httpClient } = createBackend()
    const { rotate } = renderProvider({ httpClient })
    await settleTo('status', 'warning')
    fireEvent.click(screen.getByRole('button', { name: 'start phrase' }))
    await settle()

    backend.metadata = served({ recovery_continuity: 'sealed' })
    await submitCode()

    expect(rotate).not.toHaveBeenCalled()
  })

  it('does not rotate when the device loses trust mid-flow', async () => {
    const { httpClient } = createBackend()
    let trust = trusted
    const { rotate } = renderProvider({ httpClient, trust: () => trust })
    await settleTo('status', 'warning')
    fireEvent.click(screen.getByRole('button', { name: 'start phrase' }))
    await settle()

    trust = { ready: true, unverified: true }
    await submitCode()

    expect(rotate).not.toHaveBeenCalled()
  })

  it('migrates the passkey from the card action and shows passkeyUpdated', async () => {
    const { backend, httpClient } = createBackend()
    backend.metadata = served({ recovery_continuity: 'sealed', passkey_credential_id: 'credential' })
    const { migratePasskey } = renderProvider({ httpClient })
    await settleTo('passkey', 'needsUpdate')

    fireEvent.click(screen.getByRole('button', { name: 'start passkey' }))
    await settleTo('notice', 'passkeyUpdated')
    expect(migratePasskey).toHaveBeenCalledTimes(1)
  })

  it('offers no passkey action on an unverified device', async () => {
    const { backend, httpClient } = createBackend()
    backend.metadata = served({ recovery_continuity: 'sealed', passkey_credential_id: 'credential' })
    const { migratePasskey } = renderProvider({ httpClient, trust: () => ({ ready: true, unverified: true }) })
    await settleTo('passkey', 'blocked')

    fireEvent.click(screen.getByRole('button', { name: 'start passkey' }))
    await settle()
    expect(migratePasskey).not.toHaveBeenCalled()
  })
})
