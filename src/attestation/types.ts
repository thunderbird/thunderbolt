/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Locally verified evidence for one inference transport, never an agent claim. */
export type AttestationEvidence = {
  provider: string
  verifiedAt: number
  endpoint: string
  checks: readonly ('code' | 'hardware' | 'measurement' | 'channel')[]
  details: readonly { label: 'source' | 'release' | 'measurement'; value: string }[]
}

/** Ephemeral connection state. Evidence is absent whenever verification is not current. */
export type AttestationState =
  | { status: 'idle' | 'verifying' }
  | { status: 'verified'; evidence: AttestationEvidence }
  | { status: 'failed'; reason: 'verification' | 'timeout' }

/** A provider adapter publishes only evidence verified by its own SDK. */
export type AttestationReporter = {
  publish: (state: AttestationState) => void
  close: () => void
}
