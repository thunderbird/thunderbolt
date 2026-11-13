/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIdentitySignal } from '@/lib/identity-lifetime'
import { getErrorName } from '@/lib/error-utils'
import { attestationStore, type AttestationStore } from './store'
import type { AttestedClient, AttestationReporter } from './types'

const connectionRevokers = new Map<string, Set<() => void>>()

/** Credential changes revoke active transports without importing any provider SDK. */
export const revokeAttestedConnection = (connectionId: string): void => {
  for (const revoke of [...(connectionRevokers.get(connectionId) ?? [])]) {
    revoke()
  }
}

type CacheOptions<Request, Client extends AttestedClient> = {
  key: (request: Request) => string
  create: (request: Request, reporter: AttestationReporter, signal: AbortSignal) => Promise<Client>
  attestations?: AttestationStore
  /** Credentials stay private to the cache and never become an evidence key. */
  sameRequest?: (previous: Request, next: Request) => boolean
  connectionId?: (request: Request) => string | undefined
}

/** Share provider clients without sharing trust between credentials, identities, or failed generations. */
export const createAttestedClientCache = <Request, Client extends AttestedClient>({
  key: getKey,
  create,
  attestations = attestationStore,
  sameRequest = () => true,
  connectionId: getConnectionId,
}: CacheOptions<Request, Client>) => {
  type Entry = {
    key: string
    request: Request
    pending: Promise<Client>
    reporter: AttestationReporter
    controller: AbortController
    detachIdentity: () => void
  }
  const clients = new Map<string, Entry>()
  const owners = new WeakMap<object, Entry>()
  const keys = new Set<string>()

  /** Close both pending and ready adapters without allowing late evidence publication. */
  const release = (entry: Entry) => {
    entry.detachIdentity()
    entry.reporter.close()
    void entry.pending.then(
      (client) => client.close(),
      () => {},
    )
  }

  /** Retire one identity or credential generation before its replacement starts. */
  const cancel = (entry: Entry) => {
    entry.controller.abort()
    release(entry)
  }

  /** Install the cache entry before running any asynchronous vendor code. */
  const construct = (key: string, request: Request): Entry => {
    keys.add(key)
    const owner = attestations.open(key)
    const controller = new AbortController()
    const identity = getIdentitySignal()
    const connectionId = getConnectionId?.(request)
    const retire = () => {
      if (clients.get(key) === entry) {
        clients.delete(key)
        attestations.clear(key)
      }
      cancel(entry)
    }
    const reporter: AttestationReporter = {
      publish: (state) => {
        owner.publish(state)
        if (state.status === 'failed') {
          if (clients.get(key) === entry) {
            clients.delete(key)
          }
          release(entry)
        }
      },
      close: owner.close,
    }
    const entry: Entry = {
      key,
      request,
      pending: Promise.resolve().then(async () => {
        controller.signal.throwIfAborted()
        const client = await create(request, reporter, controller.signal)
        owners.set(client, entry)
        return client
      }),
      reporter,
      controller,
      detachIdentity: () => {
        identity.removeEventListener('abort', retire)
        if (connectionId) {
          const revokers = connectionRevokers.get(connectionId)
          revokers?.delete(retire)
          if (!revokers?.size) {
            connectionRevokers.delete(connectionId)
          }
        }
      },
    }
    clients.set(key, entry)
    identity.addEventListener('abort', retire, { once: true })
    if (connectionId) {
      const revokers = connectionRevokers.get(connectionId) ?? new Set<() => void>()
      revokers.add(retire)
      connectionRevokers.set(connectionId, revokers)
    }
    return entry
  }

  /** Acquire only a verified client that still belongs to this cache generation. */
  const acquire = async (
    request: Request,
    verify: (pending: Promise<Client>, signal: AbortSignal) => Promise<Client> = async (pending, signal) => {
      const client = await pending
      signal.throwIfAborted()
      await client.ensureVerified()
      return client
    },
  ): Promise<Client> => {
    const key = getKey(request)
    const existing = clients.get(key)
    if (existing && !sameRequest(existing.request, request)) {
      cancel(existing)
      clients.delete(key)
      attestations.clear(key)
    }
    const entry = clients.get(key) ?? construct(key, request)
    try {
      const client = await verify(entry.pending, entry.controller.signal)
      entry.controller.signal.throwIfAborted()
      if (clients.get(key) !== entry) {
        throw new Error('Attested connection was replaced during verification')
      }
      return client
    } catch (error) {
      if (clients.get(key) === entry) {
        entry.reporter.publish({
          status: 'failed',
          reason: getErrorName(error)?.includes('Timeout') ? 'timeout' : 'verification',
        })
      }
      throw error
    }
  }

  /** Evict only the expected client, so a stale request cannot revoke its replacement. */
  const evict = (request: Request, expectedClient?: object) => {
    const expected = expectedClient ? owners.get(expectedClient) : undefined
    if (expectedClient && (!expected || clients.get(expected.key) !== expected)) {
      return
    }
    const key = expected?.key ?? getKey(request)
    const entry = clients.get(key)
    if (entry) {
      cancel(entry)
    }
    clients.delete(key)
    attestations.clear(key)
  }

  /** Release every provider connection and failed snapshot on account teardown. */
  const clear = () => {
    clients.forEach(cancel)
    clients.clear()
    keys.forEach((key) => attestations.clear(key))
    keys.clear()
  }

  return { acquire, evict, clear }
}
