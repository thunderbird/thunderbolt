/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'
import { usesLocalProviders } from '@/lib/provider-mode'

type TinfoilClients = {
  getSystemTinfoilClient: () => Promise<unknown>
  getTinfoilClient: () => Promise<unknown>
}

/**
 * Verify the selected Tinfoil transport off the first send's critical path.
 * Attestation needs no provider API key; connection credentials are resolved at
 * inference time. Other providers never load the SDK. Failures remain visible
 * in the attestation store and cannot block selection or hydration.
 */
export const prewarmTinfoilModel = async (
  model: Pick<Model, 'provider' | 'isSystem'> | null | undefined,
  // Break the client → analytics/DAL → chat store → prewarm cycle; this does not create a separate chunk.
  loadClients: () => Promise<TinfoilClients> = () => import('./tinfoil-client'),
) => {
  if (!model || model.provider !== 'tinfoil' || (model.isSystem === 1 && usesLocalProviders())) {
    return
  }
  try {
    const clients = await loadClients()
    await (model.isSystem === 1 ? clients.getSystemTinfoilClient() : clients.getTinfoilClient())
  } catch (error) {
    // A canceled chunk download or failed attestation can be retried by the next send.
    console.warn('prewarmTinfoilModel: warm-up skipped', error)
  }
}
