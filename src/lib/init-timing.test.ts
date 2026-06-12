/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'
import {
  beginInitRun,
  getInitTimingPayload,
  markAppMounted,
  markBundleEvaluated,
  markChatReady,
  recordInitStep,
  resetInitTiming,
} from './init-timing'

describe('init-timing', () => {
  beforeEach(() => {
    resetInitTiming()
  })

  it('returns null marks before anything is recorded', () => {
    const payload = getInitTimingPayload()
    expect(payload).toEqual({
      init_run: 0,
      bundle_evaluated_ms: null,
      app_mounted_ms: null,
    })
  })

  it('records step durations rounded to whole ms', () => {
    beginInitRun()
    recordInitStep('step0_fetch_config', 12.7)
    recordInitStep('step3_wait_for_initial_sync', 9999.2)

    const payload = getInitTimingPayload()
    expect(payload.step0_fetch_config_ms).toBe(13)
    expect(payload.step3_wait_for_initial_sync_ms).toBe(9999)
    expect(payload.init_run).toBe(1)
  })

  it('first call wins for bundle and mount marks', () => {
    markBundleEvaluated()
    markAppMounted()
    const first = getInitTimingPayload()

    markBundleEvaluated()
    markAppMounted()
    const second = getInitTimingPayload()

    expect(second.bundle_evaluated_ms).toBe(first.bundle_evaluated_ms)
    expect(second.app_mounted_ms).toBe(first.app_mounted_ms)
    expect(first.bundle_evaluated_ms).not.toBeNull()
    expect(first.app_mounted_ms).not.toBeNull()
  })

  it('markChatReady returns elapsed ms once and null afterwards', () => {
    const first = markChatReady()
    expect(first).not.toBeNull()
    expect(first).toBeGreaterThan(0)

    expect(markChatReady()).toBeNull()
    expect(markChatReady()).toBeNull()
  })

  it('beginInitRun clears step durations from a previous run and bumps the counter', () => {
    beginInitRun()
    recordInitStep('step0_fetch_config', 100)

    beginInitRun()
    const payload = getInitTimingPayload()

    expect(payload.init_run).toBe(2)
    expect(payload).not.toHaveProperty('step0_fetch_config_ms')
  })

  it('keeps marks across init runs (retry should not lose bundle/mount marks)', () => {
    markBundleEvaluated()
    beginInitRun()
    beginInitRun()

    expect(getInitTimingPayload().bundle_evaluated_ms).not.toBeNull()
  })
})
