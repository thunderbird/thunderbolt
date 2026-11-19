/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createAttestationStore } from './store'
import type { AttestationState } from './types'

const verified: AttestationState = {
  status: 'verified',
  evidence: { provider: 'Example TEE', verifiedAt: 0, endpoint: 'enclave.example', checks: ['hardware'], details: [] },
}

describe('attestation store', () => {
  it('keeps evidence scoped to its transport and removes it on eviction', () => {
    const store = createAttestationStore()
    const listener = mock(() => {})
    const unsubscribe = store.subscribe(listener)
    const reporter = store.open('managed:one')
    reporter.publish(verified)
    expect(store.getSnapshot('managed:one')).toBe(verified)
    expect(store.getSnapshot('managed:two').status).toBe('idle')
    expect(store.getSnapshot('byok').status).toBe('idle')
    store.clear('managed:one')
    reporter.publish(verified)
    expect(store.getSnapshot('managed:one').status).toBe('idle')
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    store.clear('byok')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('ignores old completions, resets and failures after a replacement starts', () => {
    const store = createAttestationStore()
    const old = store.open('connection')
    old.publish(verified)
    const replacement = store.open('connection')
    expect(store.getSnapshot('connection').status).toBe('verifying')
    old.publish(verified)
    old.close()
    expect(store.getSnapshot('connection').status).toBe('verifying')
    replacement.publish(verified)
    old.publish({ status: 'failed', reason: 'timeout' })
    expect(store.getSnapshot('connection')).toBe(verified)
  })

  it('retains a failure for display while revoking timed-out callbacks', () => {
    const store = createAttestationStore()
    const reporter = store.open('connection')
    reporter.publish({ status: 'failed', reason: 'timeout' })
    reporter.close()
    reporter.publish(verified)
    expect(store.getSnapshot('connection')).toEqual({ status: 'failed', reason: 'timeout' })
  })

  it('clears all providers and revokes every outstanding reporter on identity teardown', () => {
    const store = createAttestationStore()
    const first = store.open('provider:one')
    const second = store.open('provider:two')
    first.publish(verified)
    second.publish({ status: 'failed', reason: 'timeout' })
    const listener = mock(() => {
      expect(store.getSnapshot('provider:one')).toEqual({ status: 'idle' })
      expect(store.getSnapshot('provider:two')).toEqual({ status: 'idle' })
    })
    const unsubscribe = store.subscribe(listener)
    store.clearAll()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    first.publish(verified)
    second.publish(verified)
    expect(store.getSnapshot('provider:one')).toEqual({ status: 'idle' })
    expect(store.getSnapshot('provider:two')).toEqual({ status: 'idle' })
    store.open('provider:one').publish(verified)
    expect(store.getSnapshot('provider:one')).toBe(verified)
  })
})
