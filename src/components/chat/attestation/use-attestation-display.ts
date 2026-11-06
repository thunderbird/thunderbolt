/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { AttestationTarget } from '@/attestation/target'
import type { AttestationState } from '@/attestation/types'

const labels = {
  idle: msg`Private inference`,
  verifying: msg`Verifying connection…`,
  verified: msg`Connection verified`,
  failed: msg`Verification failed`,
}

/** Describe the actual trust boundary before considering local SDK state. */
const describeAttestation = (target: AttestationTarget, state: AttestationState) => {
  if (target.kind === 'agent') {
    const agentName = target.name
    return msg`${agentName} receives this chat and manages its own model connection. This device has not verified the agent's execution environment.`
  }
  if (target.kind === 'unsupported') {
    return msg`This model is marked private, but this device cannot verify its provider yet.`
  }
  const provider = target.provider
  if (state.status === 'verified') {
    return msg`Your device verified ${provider}'s confidential inference endpoint. Model request bodies are encrypted for that enclave.`
  }
  if (state.status === 'failed') {
    return state.reason === 'timeout'
      ? msg`Verification timed out. A verified connection is required before sending to this provider.`
      : msg`The connection could not be verified. A verified connection is required before sending to this provider.`
  }
  return msg`Your device checks the enclave hardware and signed build before sending to ${provider}.`
}

/** Resolve live copy and prevent remote agents from inheriting local verification. */
export const useAttestationDisplay = (target: AttestationTarget, state: AttestationState) => {
  const { i18n } = useLingui()
  const status = target.kind === 'local' ? state.status : 'idle'
  const label =
    target.kind === 'agent'
      ? msg`Agent privacy`
      : target.kind === 'unsupported'
        ? msg`Verification unavailable`
        : labels[status]
  return { status, label: i18n._(label), description: i18n._(describeAttestation(target, state)) }
}
