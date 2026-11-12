/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAttestedClientCache } from '@/attestation/client-cache'
import { withAttestationSignal } from '@/attestation/client'
import { privatemodeAttestationKey } from '@/attestation/target'
import type { AttestedClient } from '@/attestation/types'
import { http } from '@/lib/http'

export type PrivatemodeConnection = { apiKey: string; connectionId?: string }

// This facade is safe to import from settings, identity teardown, and chat UI.
// Only an explicit connection acquisition evaluates the vendor adapter/SDK.
const clients = createAttestedClientCache<PrivatemodeConnection, AttestedClient>({
  key: ({ connectionId }) => privatemodeAttestationKey(connectionId),
  sameRequest: (previous, next) => previous.apiKey === next.apiKey,
  connectionId: ({ connectionId }) => connectionId,
  create: async ({ apiKey }, reporter, signal) => {
    const { AttestedPrivatemodeClient } = await import('@/attestation/privatemode')
    signal.throwIfAborted()
    return AttestedPrivatemodeClient.create({ apiKey, signal }, reporter, 30_000)
  },
})

/** Acquire an SDK-verified connection only after the user supplies credentials. */
export const getPrivatemodeClient = (connection: PrivatemodeConnection): Promise<AttestedClient> => {
  if (!connection.apiKey) {
    return Promise.reject(new Error('No API key provided for Privatemode'))
  }
  return clients.acquire(connection)
}

/** Check unsaved credentials on an isolated, attested transport without replacing an active connection. */
export const validatePrivatemodeApiKey = async (apiKey: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted()
  const { AttestedPrivatemodeClient } = await import('@/attestation/privatemode')
  signal.throwIfAborted()
  const client = await AttestedPrivatemodeClient.create(
    { apiKey, signal },
    { publish: () => {}, close: () => {} },
    30_000,
  )
  try {
    await withAttestationSignal(
      http.get(`${client.baseURL}/models`, { fetch: client.fetch, signal }).json<unknown>(),
      signal,
    )
  } finally {
    await client.close()
  }
}

/** Discard credential-bound evidence and encryption state when a connection changes. */
export const evictPrivatemodeClient = (connectionId?: string, client?: object): void =>
  clients.evict({ connectionId, apiKey: '' }, client)

/** Revoke every Privatemode connection without loading its SDK. */
export const clearPrivatemodeClients = clients.clear
