/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AttestationTarget } from '@/attestation/target'
import type { AttestationState } from '@/attestation/types'

export type AttestationControlProps = {
  target: AttestationTarget
  state: AttestationState
  onVerify: () => Promise<void>
}
