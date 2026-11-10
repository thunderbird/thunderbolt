/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as encryptionService from '@/services/encryption'
import * as encryptionApi from '@/api/encryption'
import * as passkeys from '@/lib/passkey'
import { DecryptionError, DeviceApprovalError, ValidationError } from '@/crypto/errors'
import { EncryptedSyncUnsupportedError } from '@/lib/encrypted-sync-support'
import { HttpError } from '@/lib/http'
import type { EncryptionMetadataResponse } from '@shared/e2ee-types'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { classifyEncryptionMetadata, reducer, initialState, useSyncSetup } from './use-sync-setup'
import { act, cleanup, renderHook } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { clearAllKeys, generateAK, generateKeyPair, generateMlKemKeyPair, getAK, storeKeyPair, wrapAK } from '@/crypto'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { createSpyHttpClient } from '@/test-utils/http-client-spy'
import { clearCachedSession, setCachedSession } from '@/lib/session-cache'
import { EncryptionRequestTimeoutError } from '@/services/encryption-request'

const metadata = (schemeVersion: 1 | 2): EncryptionMetadataResponse => ({
  canary_iv: 'iv',
  canary_ctext: 'ct',
  kdf_salt: schemeVersion === 2 ? 'salt' : null,
  signing_public_key: schemeVersion === 2 ? 'spki' : null,
  recovery_ecdh_public_key: schemeVersion === 2 ? 'recovery-ecdh' : null,
  recovery_mlkem_public_key: schemeVersion === 2 ? 'recovery-mlkem' : null,
  recovery_wrapped_ak: schemeVersion === 2 ? 'recovery-envelope' : null,
  recovery_attestation: schemeVersion === 2 ? 'recovery-attestation' : null,
  passkey_credential_id: null,
  passkey_ecdh_public_key: null,
  passkey_mlkem_public_key: null,
  passkey_wrapped_ak: null,
  passkey_attestation: null,
  key_version: 1,
  primary_key_id: '0',
  scheme_version: schemeVersion,
})

describe('receiver verification failure', () => {
  afterEach(async () => {
    cleanup()
    await clearAllKeys()
    clearCachedSession()
    localStorage.removeItem('thunderbolt_device_id')
  })

  const receiverWrapper = async () => {
    await clearAllKeys()
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    await storeKeyPair(ecdh.privateKey, ecdh.publicKey, mlkem.publicKey, mlkem.secretKey)
    localStorage.setItem('thunderbolt_device_id', 'receiver')
    setCachedSession({ user: { id: 'account-1' } })
    const wrappedCK = await wrapAK(await generateAK(true), ecdh.publicKey, mlkem.publicKey, '0')
    const { httpClient } = createSpyHttpClient(async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/devices')) {
        return Response.json({ trusted: false })
      }
      if (path.endsWith('/envelope')) {
        return Response.json({ trusted: true, wrappedCK, attestation: null })
      }
      if (path.endsWith('/keys')) {
        return Response.json({ keys: [] })
      }
      return Response.json({ ...metadata(2), passkey_credential_id: 'available-passkey' })
    })
    return createQueryTestWrapper({ httpClient })
  }

  it('offers retry and available-option guidance instead of raw attestation diagnostics', async () => {
    const { result } = renderHook(() => useSyncSetup(), { wrapper: await receiverWrapper() })
    await act(async () => {
      expect(await result.current.confirmApproval()).toBe(false)
    })
    expect(result.current.approvalError).toBe(
      "Couldn't verify this device's approval. Select Check now to try again, or choose another option below.",
    )
    expect(result.current.isLoading).toBe(false)
    expect(await getAK()).toBeNull()
  })

  it('routes a receiver-verification failure at detection to existing recovery and passkey choices', async () => {
    const { result } = renderHook(() => useSyncSetup(), { wrapper: await receiverWrapper() })
    await act(async () => {
      expect((await result.current.continueIntro()).outcome).toBe('additional-device')
    })
    expect(result.current.step).toBe('approval-waiting')
    expect(result.current.passkeySlotCredentialId).toBe('available-passkey')
    expect(result.current.approvalError).toContain('Check now')
    expect(result.current.approvalError).toContain('another option below')
    expect(await getAK()).toBeNull()
  })
})

describe('classifyEncryptionMetadata', () => {
  it('returns "none" when there is no metadata (404)', () => {
    expect(classifyEncryptionMetadata(null)).toBe('none')
  })

  it('returns "v1" for a legacy scheme_version === 1 account', () => {
    expect(classifyEncryptionMetadata(metadata(1))).toBe('v1')
  })

  it('returns "v2" for a migrated scheme_version === 2 account', () => {
    expect(classifyEncryptionMetadata(metadata(2))).toBe('v2')
  })
})

describe('useSyncSetup reducer', () => {
  it('retains the locally computed fingerprint while entering approval and clears it on reset', () => {
    const prepared = reducer(initialState, { type: 'SET_APPROVAL_FINGERPRINT', payload: 'local-fingerprint' })
    const waiting = reducer(prepared, { type: 'DETECTED_ADDITIONAL_DEVICE' })
    expect(waiting.approvalFingerprint).toBe('local-fingerprint')
    expect(reducer(waiting, { type: 'RESET' }).approvalFingerprint).toBe('')
  })
  it('routes a migration into the recovery-key display step', () => {
    const next = reducer(initialState, { type: 'SET_RECOVERY_KEY', payload: 'word '.repeat(24).trim() })
    expect(next.step).toBe('recovery-key-display')
    expect(next.recoveryKey).toContain('word')
    expect(next.isLoading).toBe(false)
  })

  it('sends an additional device to the approval-waiting step', () => {
    const next = reducer(initialState, { type: 'DETECTED_ADDITIONAL_DEVICE' })
    expect(next.step).toBe('approval-waiting')
  })

  it('sends a first device to first-device-setup', () => {
    const next = reducer(initialState, { type: 'DETECTED_FIRST_DEVICE' })
    expect(next.step).toBe('first-device-setup')
  })

  it('routes a denied device to the denied step and stops the spinner', () => {
    // The approval-waiting device polls; a denial is the terminal answer, so it
    // must leave the waiting step AND clear isLoading or the UI spins forever.
    const waiting = reducer(initialState, { type: 'DETECTED_ADDITIONAL_DEVICE' })
    const next = reducer({ ...waiting, isLoading: true }, { type: 'DEVICE_DENIED' })
    expect(next.step).toBe('denied')
    expect(next.isLoading).toBe(false)
  })

  it('remembers the account passkey slot found at detection', () => {
    const next = reducer(initialState, { type: 'SET_PASSKEY_SLOT', payload: 'cred-1' })
    expect(next.passkeySlotCredentialId).toBe('cred-1')
    expect(next.step).toBe('intro')
  })

  it('routes into the passkey step and records where to go next', () => {
    const loading = { ...initialState, step: 'recovery-key-display' as const, isLoading: true }
    const next = reducer(loading, { type: 'GO_TO_PASSKEY_ENROLL', payload: 'close' })
    expect(next.step).toBe('passkey-enroll')
    expect(next.afterPasskey).toBe('close')
    expect(next.isLoading).toBe(false)
  })

  it('clears an error without disturbing the current step', () => {
    const errored = reducer(initialState, { type: 'SET_ERROR', payload: 'boom' })
    expect(errored.error).toBe('boom')
    expect(errored.isLoading).toBe(false)

    const cleared = reducer(errored, { type: 'CLEAR_ERROR' })
    expect(cleared.error).toBeNull()
    expect(cleared.step).toBe(errored.step)
  })

  it('GO_BACK returns to intro from a terminal step, RESET returns to the initial state', () => {
    const denied = reducer(initialState, { type: 'DEVICE_DENIED' })

    expect(reducer(denied, { type: 'GO_BACK' })).toEqual({ ...initialState, step: 'intro' })
    expect(reducer(denied, { type: 'RESET' })).toEqual(initialState)
  })
})

it('holds the active step while an encryption operation is in flight', () => {
  const busy = { ...initialState, step: 'recovery-key-entry' as const, isLoading: true }
  expect(reducer(busy, { type: 'GO_BACK' })).toBe(busy)
  expect(reducer(busy, { type: 'GO_TO_RECOVERY_KEY_ENTRY' })).toBe(busy)
  expect(reducer(busy, { type: 'RETURN_TO_APPROVAL' })).toBe(busy)
})

it('keeps recovery active when Back is pressed before recovery finishes', async () => {
  const response = Promise.withResolvers<void>()
  const recover = spyOn(encryptionService, 'recoverWithKey').mockImplementation(() => response.promise)
  try {
    const { result } = renderHook(() => useSyncSetup(), { wrapper: createQueryTestWrapper() })
    act(() => result.current.goToRecoveryKeyEntry())
    act(() => result.current.setRecoveryKeyInput('word '.repeat(24)))
    let pending: Promise<boolean>
    act(() => {
      pending = result.current.submitRecoveryKey()
      result.current.chooseAdditionalDevice()
    })
    expect(result.current.step).toBe('recovery-key-entry')
    expect(result.current.isLoading).toBe(true)
    await act(async () => {
      response.resolve()
      expect(await pending).toBe(true)
    })
  } finally {
    recover.mockRestore()
  }
})

it('displays timeout guidance instead of the internal request error during setup', async () => {
  const setup = spyOn(encryptionService, 'completeFirstDeviceSetup').mockRejectedValue(
    new EncryptionRequestTimeoutError(),
  )
  try {
    const { result } = renderHook(() => useSyncSetup(), { wrapper: createQueryTestWrapper() })
    await act(async () => result.current.continueFirstDeviceSetup())
    expect(result.current.error).toBe('The server took too long to respond. Please try again.')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.recoveryKey).toBe('')
  } finally {
    setup.mockRestore()
  }
})

it('admits one key setup at a time and ignores its result after resetting the wizard', async () => {
  const response = Promise.withResolvers<string>()
  const setup = spyOn(encryptionService, 'completeFirstDeviceSetup').mockImplementation(() => response.promise)
  try {
    const { result } = renderHook(() => useSyncSetup(), { wrapper: createQueryTestWrapper() })
    let first: Promise<void>
    act(() => {
      first = result.current.continueFirstDeviceSetup()
    })
    await act(async () => {
      await result.current.continueFirstDeviceSetup()
    })
    expect(setup).toHaveBeenCalledTimes(1)
    act(() => result.current.reset())
    await act(async () => {
      response.resolve('late recovery phrase')
      await first
    })
    expect(result.current.step).toBe('intro')
    expect(result.current.recoveryKey).toBe('')
  } finally {
    setup.mockRestore()
  }
})

describe('sync setup operation outcomes', () => {
  const createSpies = () => ({
    register: spyOn(encryptionService, 'registerThisDevice').mockResolvedValue({ trusted: false }),
    fingerprint: spyOn(encryptionService, 'getThisDeviceApprovalFingerprint').mockResolvedValue('fingerprint'),
    metadata: spyOn(encryptionApi, 'fetchEncryptionMetadata').mockResolvedValue({
      ...metadata(2),
      passkey_credential_id: 'credential',
    }),
    ensure: spyOn(encryptionService, 'ensureV2Encryption').mockResolvedValue({ outcome: 'awaiting-approval' }),
    bootstrap: spyOn(encryptionService, 'completeFirstDeviceSetup').mockResolvedValue('recovery phrase'),
    canary: spyOn(encryptionApi, 'checkCanaryExists').mockResolvedValue(true),
    recover: spyOn(encryptionService, 'recoverWithKey').mockResolvedValue(undefined),
    approve: spyOn(encryptionService, 'checkApprovalAndUnwrap').mockResolvedValue(true),
    prf: spyOn(passkeys, 'getPasskeyPrfOutput').mockResolvedValue(new Uint8Array([1, 2, 3])),
    unlock: spyOn(encryptionService, 'unlockWithPasskey').mockResolvedValue(undefined),
  })
  let spies: ReturnType<typeof createSpies>
  beforeEach(() => {
    spies = createSpies()
  })
  afterEach(() => {
    cleanup()
    Object.values(spies).forEach((spy) => spy.mockRestore())
  })
  const mount = () => renderHook(useSyncSetup, { wrapper: createQueryTestWrapper() })
  const httpError = (status: number) => new HttpError(new Response(null, { status }))

  it('shows a localized upgrade instruction when the runtime cannot coordinate encrypted sync', async () => {
    spies.register.mockRejectedValueOnce(new EncryptedSyncUnsupportedError())
    const { result } = mount()
    await act(async () => {
      expect((await result.current.continueIntro()).outcome).toBe('error')
    })
    expect(result.current.error).toBe(
      'To use encrypted sync, open this app over HTTPS and use an up-to-date browser or operating system.',
    )
    expect(result.current.isLoading).toBe(false)
    expect(spies.ensure).not.toHaveBeenCalled()
  })

  it('starts first-device setup only when metadata is absent', async () => {
    spies.metadata.mockRejectedValueOnce(httpError(404))
    const { result } = mount()
    await act(async () => expect((await result.current.continueIntro()).outcome).toBe('first-device'))
    expect(result.current.step).toBe('first-device-setup')
    expect(spies.ensure).not.toHaveBeenCalled()
    await act(async () => result.current.continueFirstDeviceSetup())
    expect(result.current.recoveryKey).toBe('recovery phrase')
    expect(result.current.step).toBe('recovery-key-display')
    expect(result.current.isLoading).toBe(false)
  })

  it.each([
    [{ outcome: 'migrated', recoveryKey: 'migrated phrase' }, 'migrated', 'recovery-key-display'],
    [{ outcome: 'followed' }, 'already-trusted', 'setup-complete'],
    [{ outcome: 'already-v2' }, 'already-trusted', 'setup-complete'],
    [{ outcome: 'awaiting-approval' }, 'additional-device', 'approval-waiting'],
    [{ outcome: 'not-applicable' }, 'additional-device', 'approval-waiting'],
  ] as const)('routes encryption outcome %j', async (outcome, expected, step) => {
    spies.ensure.mockResolvedValueOnce(outcome)
    const { result } = mount()
    await act(async () => expect((await result.current.continueIntro()).outcome).toBe(expected))
    expect(result.current.step).toBe(step)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.passkeySlotCredentialId).toBe('credential')
  })

  it.each([httpError(422), new Error('Registration unavailable')])(
    'reports registration failure: %s',
    async (error) => {
      spies.register.mockRejectedValueOnce(error)
      const { result } = mount()
      await act(async () => expect((await result.current.continueIntro()).outcome).toBe('error'))
      expect(result.current.error).toContain(error instanceof HttpError ? 'maximum number of devices' : error.message)
      expect(result.current.isLoading).toBe(false)
      expect(spies.ensure).not.toHaveBeenCalled()
    },
  )

  it('does not start encryption after a cancelled metadata lookup', async () => {
    const response = Promise.withResolvers<EncryptionMetadataResponse>()
    spies.metadata.mockImplementationOnce(() => response.promise)
    const { result } = mount()
    let pending: ReturnType<typeof result.current.continueIntro>
    await act(async () => {
      pending = result.current.continueIntro()
    })
    act(() => result.current.reset())
    await act(async () => {
      response.resolve(metadata(2))
      await pending
    })
    expect(spies.ensure).not.toHaveBeenCalled()
    expect(result.current.step).toBe('intro')
  })

  it.each([true, false, 'failed'] as const)(
    'handles a bootstrap collision when canary lookup is %s',
    async (canary) => {
      spies.bootstrap.mockRejectedValueOnce(httpError(403))
      if (canary === 'failed') {
        spies.canary.mockRejectedValueOnce(new Error('offline'))
      } else {
        spies.canary.mockResolvedValueOnce(canary)
      }
      const { result } = mount()
      await act(async () => result.current.continueFirstDeviceSetup())
      expect(result.current.isLoading).toBe(false)
      expect(result.current.step).toBe(canary === true ? 'approval-waiting' : 'intro')
      expect(result.current.error).toBe(canary === false ? 'Request failed with status 403' : null)
    },
  )

  it.each(['', 'word word'])('rejects an incomplete recovery phrase before calling the service', async (phrase) => {
    const { result } = mount()
    act(() => result.current.setRecoveryKeyInput(phrase))
    await act(async () => expect(await result.current.submitRecoveryKey()).toBe(false))
    expect(result.current.recoveryKeyError).toContain(`you entered ${phrase ? 2 : 0}`)
    expect(spies.recover).not.toHaveBeenCalled()
  })

  it('normalizes recovery words and exposes verification failures', async () => {
    const { result } = mount()
    act(() => result.current.setRecoveryKeyInput('  WORD\n'.repeat(24)))
    spies.recover.mockRejectedValueOnce(new ValidationError('bad phrase'))
    await act(async () => expect(await result.current.submitRecoveryKey()).toBe(false))
    expect(spies.recover).toHaveBeenCalledWith(expect.anything(), 'word '.repeat(24).trim())
    expect(result.current.recoveryKeyError).toContain('Invalid recovery phrase')
    spies.recover.mockRejectedValueOnce(new Error('offline'))
    await act(async () => expect(await result.current.submitRecoveryKey()).toBe(false))
    expect(result.current.recoveryKeyError).toBe('offline')
    expect(result.current.isLoading).toBe(false)
  })

  it.each([
    [false, 'intro', 'not been approved'],
    [httpError(422), 'denied', null],
    [new DeviceApprovalError('recipient-unverified'), 'intro', "Couldn't verify"],
    [new Error('Failed to unwrap account key'), 'intro', "Couldn't verify"],
    [new EncryptionRequestTimeoutError(), 'intro', 'took too long'],
    [true, 'intro', null],
  ] as const)('settles approval outcome %s', async (outcome, step, message) => {
    if (outcome instanceof Error) {
      spies.approve.mockRejectedValueOnce(outcome)
    } else {
      spies.approve.mockResolvedValueOnce(outcome)
    }
    const { result } = mount()
    await act(async () => expect(await result.current.confirmApproval()).toBe(outcome === true))
    expect(result.current.step).toBe(step)
    expect(result.current.isLoading).toBe(false)
    if (message) {
      expect(result.current.approvalError).toContain(message)
    } else {
      expect(result.current.approvalError).toBeNull()
    }
  })

  it('does not prompt for a passkey when the account has no slot', async () => {
    const { result } = mount()
    await act(async () => expect(await result.current.unlockWithPasskey()).toBe(false))
    expect(spies.prf).not.toHaveBeenCalled()
  })

  it.each([
    [null, "can't unlock sync on this device"],
    [new DOMException('cancelled', 'NotAllowedError'), null],
    [new ValidationError('wrong account'), "can't unlock sync for this account"],
    [new Error('offline'), "Couldn't unlock sync"],
  ] as const)('settles an unsuccessful passkey attempt: %s', async (outcome, message) => {
    const { result } = mount()
    await act(async () => result.current.continueIntro())
    if (outcome instanceof Error) {
      spies.prf.mockRejectedValueOnce(outcome)
    } else {
      spies.prf.mockResolvedValueOnce(outcome)
    }
    await act(async () => expect(await result.current.unlockWithPasskey()).toBe(false))
    expect(result.current.isLoading).toBe(false)
    expect(spies.unlock).not.toHaveBeenCalled()
    if (message) {
      expect(result.current.approvalError).toContain(message)
    } else {
      expect(result.current.approvalError).toBeNull()
    }
  })

  it('stages keys only for a current passkey attempt', async () => {
    const response = Promise.withResolvers<Uint8Array | null>()
    const { result } = mount()
    await act(async () => result.current.continueIntro())
    spies.prf.mockImplementationOnce(() => response.promise)
    let pending: Promise<boolean>
    act(() => {
      pending = result.current.unlockWithPasskey()
    })
    act(() => result.current.reset())
    await act(async () => {
      response.resolve(new Uint8Array([4]))
      expect(await pending).toBe(false)
    })
    expect(spies.unlock).not.toHaveBeenCalled()
    await act(async () => result.current.continueIntro())
    await act(async () => expect(await result.current.unlockWithPasskey()).toBe(true))
    expect(spies.unlock).toHaveBeenCalledTimes(1)
  })

  it('shows a failure the automatic check keeps hitting, without its internal message', () => {
    const { result } = mount()
    act(() => result.current.approvalCheckFailed(new DecryptionError('Failed to unwrap account key')))
    expect(result.current.approvalError).toBe(
      "Couldn't verify this device's approval. Select Check now to try again, or choose another option below.",
    )
    act(() => result.current.approvalCheckFailed(new EncryptedSyncUnsupportedError()))
    expect(result.current.approvalError).toBe(
      'To use encrypted sync, open this app over HTTPS and use an up-to-date browser or operating system.',
    )
  })

  it('ignores polling callbacks while a manual operation owns the wizard, before effect cleanup', async () => {
    const response = Promise.withResolvers<boolean>()
    spies.approve.mockImplementationOnce(() => response.promise)
    const { result } = mount()
    let pending: Promise<boolean>
    act(() => {
      pending = result.current.confirmApproval()
      result.current.approvalVerificationFailed()
      result.current.approvalCheckFailed(new DecryptionError('Envelope could not be opened'))
      result.current.deviceDenied()
      result.current.completeSetup()
      result.current.goToPasskeyEnroll('complete')
    })
    expect(result.current.step).toBe('intro')
    expect(result.current.isLoading).toBe(true)
    expect(result.current.approvalError).toBeNull()
    await act(async () => {
      response.resolve(true)
      await pending
    })
    act(() => result.current.completeSetup())
    expect(result.current.step).toBe('setup-complete')
  })
})
