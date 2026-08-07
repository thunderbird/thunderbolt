/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The cloud-execution disclosure. One property: it shows once per device, and
 * "once" survives a reload mid-notice — so the seen flag is written when the
 * notice appears, not when the user dismisses it.
 */

import '@/testing-library'

import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import { beforeEach, describe, expect, it } from 'bun:test'
import { announceCloudExecution, useCloudExecutionNoticeStore } from './cloud-execution-notice'

describe('announceCloudExecution', () => {
  beforeEach(() => {
    useLocalSettingsStore.getState().setLocalSetting('hasSeenCloudExecutionNotice', false)
    useCloudExecutionNoticeStore.setState({ isVisible: false })
  })

  it('shows the notice on the first runner-placed send', () => {
    announceCloudExecution()

    expect(useCloudExecutionNoticeStore.getState().isVisible).toBe(true)
  })

  it('records the disclosure as it appears, not on dismissal', () => {
    announceCloudExecution()

    expect(getLocalSetting('hasSeenCloudExecutionNotice')).toBe(true)
  })

  it('stays dismissed for every later send', () => {
    announceCloudExecution()
    useCloudExecutionNoticeStore.getState().dismiss()

    announceCloudExecution()

    expect(useCloudExecutionNoticeStore.getState().isVisible).toBe(false)
  })

  it('does not re-disclose to a device that already saw it', () => {
    useLocalSettingsStore.getState().setLocalSetting('hasSeenCloudExecutionNotice', true)

    announceCloudExecution()

    expect(useCloudExecutionNoticeStore.getState().isVisible).toBe(false)
  })
})
