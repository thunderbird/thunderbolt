/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  approvalCodeAttemptsKey,
  approvalCodeAttemptsLockName,
  approvalCodeFailureWindowMs,
  canUseApprovalCode,
  forgiveApprovalCodeAttempt,
  startApprovalCodeAttempt,
} from './approval-code-attempts'

const now = 1_000_000_000_000

describe('approval code attempts', () => {
  afterEach(() => {
    localStorage.removeItem(approvalCodeAttemptsKey)
  })

  it('switches the code path off after three attempts in a day', async () => {
    await startApprovalCodeAttempt(now)
    await startApprovalCodeAttempt(now + 1)
    expect(canUseApprovalCode(now + 2)).toBe(true)
    await startApprovalCodeAttempt(now + 2)
    expect(canUseApprovalCode(now + 3)).toBe(false)
  })

  it('refuses to reserve a fourth attempt', async () => {
    await startApprovalCodeAttempt(now)
    await startApprovalCodeAttempt(now + 1)
    expect(await startApprovalCodeAttempt(now + 2)).toBe(now + 2)
    expect(await startApprovalCodeAttempt(now + 3)).toBeNull()
  })

  it('forgives an attempt that ended in approval', async () => {
    await startApprovalCodeAttempt(now)
    await startApprovalCodeAttempt(now + 1)
    await forgiveApprovalCodeAttempt((await startApprovalCodeAttempt(now + 2))!)
    expect(canUseApprovalCode(now + 3)).toBe(true)
  })

  it('lets attempts age out after 24 hours', async () => {
    await startApprovalCodeAttempt(now)
    await startApprovalCodeAttempt(now + 1)
    await startApprovalCodeAttempt(now + 2)
    expect(canUseApprovalCode(now + approvalCodeFailureWindowMs)).toBe(true)
  })

  it('treats an unreadable record as no attempts', () => {
    localStorage.setItem(approvalCodeAttemptsKey, '{not json')
    expect(canUseApprovalCode(now)).toBe(true)
    localStorage.setItem(approvalCodeAttemptsKey, '{"a":1}')
    expect(canUseApprovalCode(now)).toBe(true)
  })

  it('reads the record only once another tab has finished writing it', async () => {
    await startApprovalCodeAttempt(now)
    await startApprovalCodeAttempt(now + 1)
    const otherTab = Promise.withResolvers<void>()
    const otherTabDone = navigator.locks.request(approvalCodeAttemptsLockName, async () => {
      await otherTab.promise
      localStorage.setItem(approvalCodeAttemptsKey, JSON.stringify([now, now + 1, now + 2]))
    })
    const reservation = startApprovalCodeAttempt(now + 3)
    otherTab.resolve()
    await otherTabDone
    expect(await reservation).toBeNull()
    expect(JSON.parse(localStorage.getItem(approvalCodeAttemptsKey)!)).toEqual([now, now + 1, now + 2])
  })
})
