/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AttestationReporter, AttestationState } from './types'

export const idleAttestation: AttestationState = { status: 'idle' }

/** Keep evidence in memory, scoped to a transport and its current client generation. */
export const createAttestationStore = () => {
  const states = new Map<string, AttestationState>()
  const owners = new Map<string, symbol>()
  const listeners = new Set<() => void>()

  /** Notify subscribers only after the replacement snapshot is available. */
  const publish = (key: string, state: AttestationState) => {
    states.set(key, state)
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: (key: string): AttestationState => states.get(key) ?? idleAttestation,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Replacing a client immediately revokes its evidence and all late callbacks. */
    open: (key: string): AttestationReporter => {
      const owner = Symbol(key)
      owners.set(key, owner)
      publish(key, { status: 'verifying' })
      return {
        publish: (state) => {
          if (owners.get(key) === owner) {
            publish(key, state)
          }
        },
        close: () => {
          if (owners.get(key) === owner) {
            owners.delete(key)
          }
        },
      }
    },
    /** Eviction drops the connection claim as well as the SDK client. */
    clear: (key: string) => {
      owners.delete(key)
      states.delete(key)
      listeners.forEach((listener) => listener())
    },
    /** Identity teardown revokes every provider's evidence and pending reporter. */
    clearAll: () => {
      owners.clear()
      states.clear()
      listeners.forEach((listener) => listener())
    },
  }
}

export const attestationStore = createAttestationStore()
export type AttestationStore = ReturnType<typeof createAttestationStore>
