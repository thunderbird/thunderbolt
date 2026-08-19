/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { describe, expect, it, mock } from 'bun:test'
import {
  clearAllKeys,
  encrypt,
  generateAK,
  getKeyVersion,
  mintDEK,
  storeAK,
  storeDEK,
  storeKeyVersion,
  storePrimaryKeyId,
  unwrapDEK,
  wrapDEK,
} from '@/crypto'
import { encodeAAD, type KeyId } from '@shared/e2ee-types'

// Re-provide the real config module to override leaked mocks from other test
// files (bun's mock.module leaks across files and can replace encryptedColumnsMap).
const realConfig = await import('./config')
mock.module('@/db/encryption/config', () => ({ ...realConfig }))

const { formatWireValue } = await import('./wire-format')
const { codec, resetCodecState, setKeysSyncChannelForTesting } = await import('./codec')
const { createKeyRequestResponder, startKeyRequestResponder } = await import('./key-request-responder')

type KeysSyncMessage = import('./codec').KeysSyncMessage
type KeysSyncChannel = import('./codec').KeysSyncChannel

const ctx = { table: 'tasks', column: 'item', rowId: 'row-1' }

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

/**
 * In-memory BroadcastChannel hub with real semantics: a message posted on one
 * port is delivered to every OTHER port (never back to the poster). The codec
 * and the responder each get their own port, exactly like two
 * `new BroadcastChannel(...)` instances.
 */
const createHub = () => {
  const posted: KeysSyncMessage[] = []
  type Port = { listeners: Array<(message: KeysSyncMessage) => void>; channel: KeysSyncChannel }
  const ports: Port[] = []
  const createPort = (): KeysSyncChannel => {
    const listeners: Port['listeners'] = []
    const channel: KeysSyncChannel = {
      postMessage: (message) => {
        posted.push(message)
        for (const port of ports) {
          if (port.channel !== channel) {
            port.listeners.forEach((listener) => listener(message))
          }
        }
      },
      onMessage: (listener) => listeners.push(listener),
    }
    ports.push({ listeners, channel })
    return channel
  }
  return { posted, createPort }
}

// setImmediate is NOT faked by the global sinon fake-timers preload, so poll on
// it to let fake-indexeddb + WebCrypto callbacks progress.
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) {
      return
    }
    await flushAsync()
  }
  throw new Error('waitFor timed out')
}

const setupKeyring = async (keyIds: KeyId[], primary: KeyId) => {
  const ak = await generateAK()
  await storeAK(ak)
  const deks = new Map<KeyId, { dek: CryptoKey; wrappedKey: string }>()
  for (const keyId of keyIds) {
    const minted = await mintDEK(ak)
    await storeDEK(keyId, minted.wrappedKey)
    deks.set(keyId, minted)
  }
  await storePrimaryKeyId(primary)
  return { ak, deks }
}

const encryptUnder = async (dek: CryptoKey, keyId: KeyId, plaintext: string): Promise<string> => {
  const { iv, ciphertext } = await encrypt(plaintext, dek, encodeAAD(ctx.table, ctx.column, ctx.rowId, keyId))
  return formatWireValue(keyId, iv, ciphertext)
}

type Hub = ReturnType<typeof createHub>

const setup = async (): Promise<Hub> => {
  await deleteDatabase()
  // clearAllKeys empties whichever key-storage backend is bound — the real
  // fake-indexeddb one, or the Map-backed mock leaked from services tests
  // (deleteDatabase does not clear those Maps, so stale DEKs would bleed in).
  await clearAllKeys()
  const hub = createHub()
  setKeysSyncChannelForTesting(hub.createPort())
  resetCodecState()
  hub.posted.length = 0
  return hub
}

const failIfCalled = (name: string) => async () => {
  throw new Error(`${name} must not be called`)
}

describe('prime — startup staging + key_version polling', () => {
  it('stages the keyring once on start for an already-set-up device and records key_version', async () => {
    const hub = await setup()
    await setupKeyring(['0'], '0')

    const stage = mock(async () => {})
    const responder = createKeyRequestResponder({
      stageKeyring: stage,
      refreshAK: failIfCalled('refreshAK'),
      fetchMetadata: async () => ({ key_version: 3 }),
      channel: hub.createPort(),
    })
    await responder.ready

    expect(stage).toHaveBeenCalledTimes(1)
    expect(await getKeyVersion()).toBe(3)
    expect(hub.posted).toEqual([])
    responder.stop()
  })

  it('refreshes the AK on start when the polled key_version is above the persisted baseline', async () => {
    const hub = await setup()
    await setupKeyring(['0'], '0')
    await storeKeyVersion(1)

    const refresh = mock(async () => {})
    const responder = createKeyRequestResponder({
      stageKeyring: failIfCalled('stageKeyring'),
      refreshAK: refresh,
      fetchMetadata: async () => ({ key_version: 2 }),
      channel: hub.createPort(),
    })
    await responder.ready

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(hub.posted).toContainEqual({ type: 'ak-refreshed' })
    expect(await getKeyVersion()).toBe(2)
    responder.stop()
  })

  it('an AK rotation with unchanged DEKs does not interrupt sync — decode works with no key-request', async () => {
    const hub = await setup()
    // Old state: DEK '0' wrapped under the old AK, baseline key_version 1.
    const { ak, deks } = await setupKeyring(['0'], '0')
    await storeKeyVersion(1)
    const wireValue = await encryptUnder(deks.get('0')!.dek, '0', 'still readable')

    // Server-side AK rotation: the SAME DEK re-wrapped under a NEW AK (mirrors
    // rotateAK: unwrap extractable under old AK, wrap under new), key_version 2.
    const newAK = await generateAK()
    const rewrappedDEK0 = await wrapDEK(await unwrapDEK(deks.get('0')!.wrappedKey, ak, true), newAK)

    const responder = createKeyRequestResponder({
      stageKeyring: failIfCalled('stageKeyring'),
      refreshAK: async () => {
        // Like the real refreshAK: store the new AK, re-stage the re-wrapped keyring.
        await storeAK(newAK)
        await storeDEK('0', rewrappedDEK0)
      },
      fetchMetadata: async () => ({ key_version: 2 }),
      channel: hub.createPort(),
    })
    await responder.ready

    expect(await codec.decode(wireValue, ctx)).toBe('still readable')
    expect(hub.posted.filter((message) => message.type === 'key-request')).toEqual([])
    responder.stop()
  })

  it('skips priming when device setup is incomplete (no AK/DEKs)', async () => {
    const hub = await setup()
    const fetchMetadata = mock(async () => ({ key_version: 1 }))
    const responder = createKeyRequestResponder({
      stageKeyring: failIfCalled('stageKeyring'),
      refreshAK: failIfCalled('refreshAK'),
      fetchMetadata,
      channel: hub.createPort(),
    })
    await responder.ready
    expect(fetchMetadata).not.toHaveBeenCalled()
    responder.stop()
  })
})

describe('key-request handling (integration with the real codec)', () => {
  // Most of these leave the keyring incomplete (no AK staged) at responder
  // creation so `prime()` no-ops (staging on prime would pre-empt the request
  // path) — the responder answers key-requests regardless of prime by design.
  // Keyring material needed for the decode itself is staged AFTER
  // `responder.ready` resolves, once priming has already settled.

  it('unknown-key: responder stages the missing DEK, posts key-staged, and the stalled decode self-heals', async () => {
    const hub = await setup()
    // Two DEKs exist account-wide, but only '0' is staged locally — '1' "lives
    // on the server" until the responder stages it.
    const { ak, deks } = await setupKeyring(['0', '1'], '0')
    const serverSideWrapped1 = deks.get('1')!.wrappedKey
    // Drop everything again so the keyring is incomplete at responder-creation
    // time (prime no-ops) — clearAllKeys (not deleteDatabase) so the Map-backed
    // leaked mock is cleared too.
    await clearAllKeys()

    const stage = mock(async () => {
      await storeDEK('1', serverSideWrapped1)
    })
    const responder = createKeyRequestResponder({
      stageKeyring: stage,
      refreshAK: failIfCalled('refreshAK'),
      fetchMetadata: async () => ({ key_version: 1 }),
      channel: hub.createPort(),
    })
    await responder.ready

    // Stage AK + DEK '0' now that priming has already settled (a no-op, since
    // the keyring was empty above) — '1' stays "unknown" until the responder
    // handles the request below.
    await storeAK(ak)
    await storeDEK('0', deks.get('0')!.wrappedKey)
    await storePrimaryKeyId('0')

    const wireValue = await encryptUnder(deks.get('1')!.dek, '1', 'future value')
    const decoded = await codec.decode(wireValue, ctx)

    expect(decoded).toBe('future value')
    expect(stage).toHaveBeenCalledTimes(1)
    expect(hub.posted).toContainEqual({ type: 'key-request', keyId: '1', reason: 'unknown-key' })
    expect(hub.posted).toContainEqual({ type: 'key-staged', keyId: '1' })
    responder.stop()
  })

  it('unwrap-failed (revocation): responder refreshes the AK first, posts ak-refreshed, and the decode succeeds', async () => {
    const hub = await setup()
    // Post-revocation shape: this device will hold the OLD AK while DEK '1'
    // arrives (already staged) wrapped under the NEW AK. Mint the new DEK
    // before the responder is created (the keyring itself stays empty at
    // creation time, so `prime()` no-ops), then stage everything afterward.
    const newAK = await generateAK()
    const minted1 = await mintDEK(newAK)

    const refresh = mock(async () => {
      await storeAK(newAK)
    })
    const responder = createKeyRequestResponder({
      stageKeyring: failIfCalled('stageKeyring'),
      refreshAK: refresh,
      fetchMetadata: async () => ({ key_version: 2 }),
      channel: hub.createPort(),
    })
    await responder.ready

    await setupKeyring(['0'], '0')
    await storeDEK('1', minted1.wrappedKey)

    const wireValue = await encryptUnder(minted1.dek, '1', 'post-revocation data')
    const decoded = await codec.decode(wireValue, ctx)

    expect(decoded).toBe('post-revocation data')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(hub.posted).toContainEqual({ type: 'key-request', keyId: '1', reason: 'unwrap-failed' })
    expect(hub.posted).toContainEqual({ type: 'ak-refreshed' })
    responder.stop()
  })

  it('escalates an unknown-key request to refreshAK when the polled key_version bumped', async () => {
    const hub = await setup()
    await setupKeyring(['0'], '0')

    const stage = mock(async () => {})
    const refresh = mock(async () => {})
    const versions = [1, 2]
    const responder = createKeyRequestResponder({
      stageKeyring: stage,
      refreshAK: refresh,
      fetchMetadata: async () => ({ key_version: versions.shift() ?? 2 }),
      channel: hub.createPort(),
    })
    await responder.ready
    expect(stage).toHaveBeenCalledTimes(1) // prime staged at baseline version 1

    const workerPort = hub.createPort()
    workerPort.postMessage({ type: 'key-request', keyId: '5', reason: 'unknown-key' })
    await waitFor(() => hub.posted.some((message) => message.type === 'ak-refreshed'))

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(stage).toHaveBeenCalledTimes(1) // no second staging pass
    expect(hub.posted).not.toContainEqual({ type: 'key-staged', keyId: '5' })
    responder.stop()
  })

  it('coalesces concurrent requests for the same key_id into one staging fetch', async () => {
    const hub = await setup()

    let releaseStage!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseStage = resolve
    })
    const stage = mock(async () => gate)
    const responder = createKeyRequestResponder({
      stageKeyring: stage,
      refreshAK: failIfCalled('refreshAK'),
      fetchMetadata: async () => ({ key_version: 1 }),
      channel: hub.createPort(),
    })
    await responder.ready

    const workerPort = hub.createPort()
    workerPort.postMessage({ type: 'key-request', keyId: '7', reason: 'unknown-key' })
    workerPort.postMessage({ type: 'key-request', keyId: '7', reason: 'unknown-key' })
    await waitFor(() => stage.mock.calls.length > 0)
    for (let i = 0; i < 20; i++) {
      await flushAsync()
    }

    expect(stage).toHaveBeenCalledTimes(1)
    releaseStage()
    await waitFor(() => hub.posted.some((message) => message.type === 'key-staged'))
    expect(hub.posted.filter((message) => message.type === 'key-staged')).toHaveLength(1)
    responder.stop()
  })

  it('loop guard: does not re-run the same key_id within the cooldown when staging never produces it', async () => {
    const hub = await setup()

    let clock = 0
    const stage = mock(async () => {}) // never actually produces key '9'
    const responder = createKeyRequestResponder({
      stageKeyring: stage,
      refreshAK: failIfCalled('refreshAK'),
      fetchMetadata: async () => ({ key_version: 1 }),
      channel: hub.createPort(),
      now: () => clock,
      cooldownMs: 30_000,
    })
    await responder.ready

    const workerPort = hub.createPort()
    workerPort.postMessage({ type: 'key-request', keyId: '9', reason: 'unknown-key' })
    await waitFor(() => stage.mock.calls.length === 1)

    clock = 1_000
    workerPort.postMessage({ type: 'key-request', keyId: '9', reason: 'unknown-key' })
    for (let i = 0; i < 20; i++) {
      await flushAsync()
    }
    expect(stage).toHaveBeenCalledTimes(1)

    clock = 31_000
    workerPort.postMessage({ type: 'key-request', keyId: '9', reason: 'unknown-key' })
    await waitFor(() => stage.mock.calls.length === 2)
    responder.stop()
  })

  it('loop guard: an unwrap-failed escalation bypasses a recent stage-only attempt', async () => {
    const hub = await setup()

    let clock = 0
    const stage = mock(async () => {})
    const refresh = mock(async () => {})
    const responder = createKeyRequestResponder({
      stageKeyring: stage,
      refreshAK: refresh,
      fetchMetadata: async () => ({ key_version: 1 }),
      channel: hub.createPort(),
      now: () => clock,
      cooldownMs: 30_000,
    })
    await responder.ready

    const workerPort = hub.createPort()
    workerPort.postMessage({ type: 'key-request', keyId: '9', reason: 'unknown-key' })
    await waitFor(() => hub.posted.some((message) => message.type === 'key-staged'))
    // Let the first run fully settle (key_version write + inflight cleanup) —
    // otherwise the follow-up request coalesces into it instead of escalating.
    for (let i = 0; i < 20; i++) {
      await flushAsync()
    }
    expect(stage).toHaveBeenCalledTimes(1)

    clock = 1_000
    workerPort.postMessage({ type: 'key-request', keyId: '9', reason: 'unwrap-failed' })
    await waitFor(() => refresh.mock.calls.length === 1)

    // But a second unwrap-failed within the cooldown of the refresh is suppressed.
    clock = 2_000
    workerPort.postMessage({ type: 'key-request', keyId: '9', reason: 'unwrap-failed' })
    for (let i = 0; i < 20; i++) {
      await flushAsync()
    }
    expect(refresh).toHaveBeenCalledTimes(1)
    responder.stop()
  })
})

describe('startKeyRequestResponder', () => {
  it('replaces a previous instance — only the newest responder answers', async () => {
    const hub = await setup()

    const firstStage = mock(async () => {})
    startKeyRequestResponder({
      stageKeyring: firstStage,
      refreshAK: failIfCalled('refreshAK'),
      fetchMetadata: async () => ({ key_version: 1 }),
      channel: hub.createPort(),
    })

    const secondStage = mock(async () => {})
    const second = startKeyRequestResponder({
      stageKeyring: secondStage,
      refreshAK: failIfCalled('refreshAK'),
      fetchMetadata: async () => ({ key_version: 1 }),
      channel: hub.createPort(),
    })
    await second.ready

    const workerPort = hub.createPort()
    workerPort.postMessage({ type: 'key-request', keyId: '3', reason: 'unknown-key' })
    await waitFor(() => secondStage.mock.calls.length === 1)

    expect(firstStage).not.toHaveBeenCalled()
    second.stop()
  })
})
