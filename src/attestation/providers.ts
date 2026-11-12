/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'
import type { AttestedClient } from './types'

/** Lazy adapter registry: observing a provider or rendering its UI never evaluates its SDK. */
const providers: Partial<Record<Model['provider'], (model: Model) => Promise<AttestedClient>>> = {
  tinfoil: async (model) => {
    const clients = await import('@/ai/tinfoil-client')
    return model.isSystem === 1 ? clients.getSystemTinfoilClient() : clients.getTinfoilClient()
  },
  privatemode: async (model) => {
    const { bindModelProvider } = await import('@/providers/model-connection')
    const { model: bound, assertCurrent } = await bindModelProvider(model)
    const { getPrivatemodeClient, evictPrivatemodeClient } = await import('@/ai/privatemode-client')
    const connectionId = model.providerConnectionId ?? model.id
    const client = await getPrivatemodeClient({
      apiKey: bound.apiKey ?? '',
      connectionId,
    })
    try {
      await assertCurrent()
    } catch (error) {
      evictPrivatemodeClient(connectionId, client)
      throw error
    }
    return client
  },
}

/** Verify the actual selected model through its provider's adapter. */
export const verifyAttestedModel = async (model: Model): Promise<void> => {
  await providers[model.provider]?.(model)
}
