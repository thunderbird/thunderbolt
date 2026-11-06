/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { getSystemTinfoilClient, getTinfoilClient } from '@/ai/tinfoil-client'
import { useCurrentChatSession } from '@/chats/chat-store'
import { attestationStore, idleAttestation } from '@/attestation/store'
import { resolveAttestationTarget } from '@/attestation/target'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSettings } from '@/hooks/use-settings'

/** Subscribe to the selected transport's local evidence, never a remote agent's model label. */
export const useChatAttestationState = () => {
  const { selectedAgent, selectedModel } = useCurrentChatSession()
  const { timeFormat } = useSettings({ time_format: String })
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const target = resolveAttestationTarget(selectedAgent, selectedModel, cloudUrl)
  const state = useSyncExternalStore(
    attestationStore.subscribe,
    () => (target?.kind === 'local' ? attestationStore.getSnapshot(target.key) : idleAttestation),
    () => idleAttestation,
  )

  const verify = async () => {
    if (target?.kind !== 'local') {
      return
    }
    // Verification is an explicit action; merely rendering the control must not
    // download the SDK or start a connection to a provider.
    try {
      await (target.client === 'system' ? getSystemTinfoilClient() : getTinfoilClient())
    } catch {
      // The transport publishes a failure to the same store the panel reads.
    }
  }

  return { target, state, verify, hour12: timeFormat.value === '12h' }
}
