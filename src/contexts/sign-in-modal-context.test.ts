/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { shouldPromptReEnrollment, type ReEnrollmentCheckDeps } from './sign-in-modal-context'

/** Fully-eligible baseline: signed in, syncing, E2EE on, keyring missing. */
const eligible = (overrides: Partial<ReEnrollmentCheckDeps> = {}): ReEnrollmentCheckDeps => ({
  e2eeEnabled: true,
  isSignedIn: true,
  syncEnabled: () => true,
  needsWizard: () => Promise.resolve(true),
  ...overrides,
})

describe('shouldPromptReEnrollment', () => {
  it('prompts a signed-in, syncing device whose keyring is gone', async () => {
    expect(await shouldPromptReEnrollment(eligible())).toBe(true)
  })

  it('stays quiet when the keyring is intact', async () => {
    expect(await shouldPromptReEnrollment(eligible({ needsWizard: () => Promise.resolve(false) }))).toBe(false)
  })

  it('stays quiet while sync is off — nothing is replicating yet', async () => {
    expect(await shouldPromptReEnrollment(eligible({ syncEnabled: () => false }))).toBe(false)
  })

  it('stays quiet when signed out, so the wizard never calls unauthenticated', async () => {
    expect(await shouldPromptReEnrollment(eligible({ isSignedIn: false }))).toBe(false)
  })

  it('stays quiet on a deployment with E2EE disabled', async () => {
    expect(await shouldPromptReEnrollment(eligible({ e2eeEnabled: false }))).toBe(false)
  })

  it('does not touch IndexedDB when an earlier condition already disqualifies', async () => {
    let probed = false
    const deps = eligible({
      syncEnabled: () => false,
      needsWizard: () => {
        probed = true
        return Promise.resolve(true)
      },
    })

    expect(await shouldPromptReEnrollment(deps)).toBe(false)
    expect(probed).toBe(false)
  })

  it('propagates a readiness-check failure so the caller can log it', async () => {
    const deps = eligible({ needsWizard: () => Promise.reject(new Error('idb unavailable')) })

    expect(shouldPromptReEnrollment(deps)).rejects.toThrow('idb unavailable')
  })
})
