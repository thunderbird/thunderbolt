/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import {
  clearRecoveryPhrasePending,
  isRecoveryPhrasePending,
  markRecoveryPhrasePending,
} from './recovery-phrase-pending'

const storageKey = 'thunderbolt-local-settings'

describe('recovery-phrase pending flag', () => {
  beforeEach(() => {
    clearRecoveryPhrasePending()
  })

  afterEach(() => {
    clearRecoveryPhrasePending()
    localStorage.removeItem(storageKey)
  })

  it('is false by default', () => {
    expect(isRecoveryPhrasePending()).toBe(false)
  })

  it('marks and clears', () => {
    markRecoveryPhrasePending()
    expect(isRecoveryPhrasePending()).toBe(true)

    clearRecoveryPhrasePending()
    expect(isRecoveryPhrasePending()).toBe(false)
  })

  it('is idempotent', () => {
    markRecoveryPhrasePending()
    markRecoveryPhrasePending()
    expect(isRecoveryPhrasePending()).toBe(true)

    clearRecoveryPhrasePending()
    clearRecoveryPhrasePending()
    expect(isRecoveryPhrasePending()).toBe(false)
  })

  it('persists to localStorage so it survives a reload', () => {
    // The entire point: the phrase lives in component state, so only a durable
    // marker can tell the next launch that one was never acknowledged.
    markRecoveryPhrasePending()

    const persisted = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as {
      state?: { recoveryPhrasePending?: boolean }
    }
    expect(persisted.state?.recoveryPhrasePending).toBe(true)
  })

  it('reads back as pending when the store is rehydrated from localStorage', async () => {
    // A previous session minted a phrase and died before confirmation. Written
    // straight to storage rather than via setState, which would re-persist and
    // defeat the point of the test.
    markRecoveryPhrasePending()
    const persisted = localStorage.getItem(storageKey)
    clearRecoveryPhrasePending()
    localStorage.setItem(storageKey, persisted!)

    await useLocalSettingsStore.persist.rehydrate()

    expect(isRecoveryPhrasePending()).toBe(true)
  })
})
