/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AttestationControl } from './attestation-control'
import { useChatAttestationState } from './use-chat-attestation-state'

export const ChatAttestation = () => {
  const { target, state, verify } = useChatAttestationState()
  if (!target) {
    return null
  }

  return <AttestationControl key={target.key} target={target} state={state} onVerify={verify} />
}
