/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { PostHogProvider } from '@/lib/posthog'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { getClock } from '@/testing-library'
import { PowerSyncReactivityTestProvider } from '@/test-utils/powersync-mock'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { PostHog } from 'posthog-js'
import { useAnalyticsConsent } from './use-analytics-consent'

/** A PostHog stand-in that remembers its saved choice the way the SDK does. */
const createClient = (isOptedOut: boolean) => {
  const saved = { isOptedOut }
  const client = {
    has_opted_out_capturing: () => saved.isOptedOut,
    opt_in_capturing: mock(() => {
      saved.isOptedOut = false
    }),
    opt_out_capturing: mock(() => {
      saved.isOptedOut = true
    }),
  }
  return { client, posthog: client as unknown as PostHog }
}

/**
 * Mount the hook over the reactive PowerSync mock, whose `triggerChange` makes the watched settings query re-emit:
 * the stand-in for a synced write arriving from another device. Seed the setting before mounting.
 */
const renderConsent = (posthog: PostHog | null) => {
  const triggerChangeRef = { current: null as ((tables: string[]) => void) | null }
  renderHook(() => useAnalyticsConsent(), {
    wrapper: ({ children }) => (
      <PostHogProvider client={posthog}>
        <PowerSyncReactivityTestProvider tables={['settings']} triggerChangeRef={triggerChangeRef}>
          {children}
        </PowerSyncReactivityTestProvider>
      </PostHogProvider>
    ),
  })
  return { settingsChanged: () => triggerChangeRef.current?.(['settings']) }
}

const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

beforeAll(async () => {
  await setupTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

afterEach(() => {
  useLocalSettingsStore.setState({ syncEnabled: false })
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('useAnalyticsConsent', () => {
  it('stops capturing as soon as an opt-out arrives from another device', async () => {
    await updateSettings(getDb(), { data_collection: true })
    const { client, posthog } = createClient(false)
    const { settingsChanged } = renderConsent(posthog)
    await flush()
    expect(client.opt_out_capturing).not.toHaveBeenCalled()

    await updateSettings(getDb(), { data_collection: false })
    settingsChanged()
    await flush()

    expect(client.opt_out_capturing).toHaveBeenCalledTimes(1)
  })

  it('starts capturing again when the setting is turned back on', async () => {
    await updateSettings(getDb(), { data_collection: false })
    const { client, posthog } = createClient(true)
    const { settingsChanged } = renderConsent(posthog)
    await flush()
    expect(client.opt_in_capturing).not.toHaveBeenCalled()

    await updateSettings(getDb(), { data_collection: true })
    settingsChanged()
    await flush()

    expect(client.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false })
  })

  it('holds off on a device with sync on until its first sync confirms the setting', async () => {
    await updateSettings(getDb(), { data_collection: true })
    useLocalSettingsStore.setState({ syncEnabled: true })
    const { client, posthog } = createClient(false)
    renderConsent(posthog)
    await flush()
    expect(client.opt_out_capturing).toHaveBeenCalledTimes(1)
    expect(client.opt_in_capturing).not.toHaveBeenCalled()
  })

  it('does nothing on a deployment without analytics', async () => {
    await updateSettings(getDb(), { data_collection: true })
    renderConsent(null)
    await flush()
  })
})
