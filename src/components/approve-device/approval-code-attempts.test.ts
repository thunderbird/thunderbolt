/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  approvalCodeAttemptsKey,
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

  it('switches the code path off after three attempts in a day', () => {
    startApprovalCodeAttempt(now)
    startApprovalCodeAttempt(now + 1)
    expect(canUseApprovalCode(now + 2)).toBe(true)
    startApprovalCodeAttempt(now + 2)
    expect(canUseApprovalCode(now + 3)).toBe(false)
  })

  it('refuses to reserve a fourth attempt', () => {
    startApprovalCodeAttempt(now)
    startApprovalCodeAttempt(now + 1)
    expect(startApprovalCodeAttempt(now + 2)).toBe(now + 2)
    expect(startApprovalCodeAttempt(now + 3)).toBeNull()
  })

  it('forgives an attempt that ended in approval', () => {
    startApprovalCodeAttempt(now)
    startApprovalCodeAttempt(now + 1)
    forgiveApprovalCodeAttempt(startApprovalCodeAttempt(now + 2)!)
    expect(canUseApprovalCode(now + 3)).toBe(true)
  })

  it('lets attempts age out after 24 hours', () => {
    startApprovalCodeAttempt(now)
    startApprovalCodeAttempt(now + 1)
    startApprovalCodeAttempt(now + 2)
    expect(canUseApprovalCode(now + approvalCodeFailureWindowMs)).toBe(true)
  })

  it('treats an unreadable record as no attempts', () => {
    localStorage.setItem(approvalCodeAttemptsKey, '{not json')
    expect(canUseApprovalCode(now)).toBe(true)
    localStorage.setItem(approvalCodeAttemptsKey, '{"a":1}')
    expect(canUseApprovalCode(now)).toBe(true)
  })
})
