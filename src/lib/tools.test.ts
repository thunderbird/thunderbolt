/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { HttpClient } from '@/contexts'
import { getAvailableTools, type ToolAvailabilityContext } from './tools'

// Tool config builders only capture the client inside their `execute` closures,
// so an empty stub is enough to exercise the availability branching.
const stubHttpClient = {} as HttpClient

const integrationStatus = (
  overrides: Partial<ToolAvailabilityContext['integrationStatus']> = {},
): ToolAvailabilityContext['integrationStatus'] => ({
  googleConnected: false,
  googleEnabled: false,
  googleEmail: null,
  microsoftConnected: false,
  microsoftEnabled: false,
  microsoftEmail: null,
  ...overrides,
})

const context = (overrides: Partial<ToolAvailabilityContext> = {}): ToolAvailabilityContext => ({
  settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: false },
  integrationStatus: integrationStatus(),
  ...overrides,
})

// These run WITHOUT a test database set up. The injected context must fully
// drive availability, so any reintroduced `getSettings`/`getIntegrationStatus`
// read (the duplicate the DI removed) would surface here. This locks in the
// dedup from the hot send path (`aiFetchStreamingResponse`).
describe('getAvailableTools (injected context)', () => {
  it('returns no tools when every gate is disabled', async () => {
    const tools = await getAvailableTools(stubHttpClient, undefined, context())
    expect(tools).toEqual([])
  })

  it('includes task tools when experimentalFeatureTasks is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ settings: { experimentalFeatureTasks: true, integrationsProIsEnabled: false } }),
    )
    expect(tools.length).toBeGreaterThan(0)
  })

  it('includes Google tools only when the Google integration is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ integrationStatus: integrationStatus({ googleEnabled: true }) }),
    )
    expect(tools.some((tool) => tool.name.startsWith('google'))).toBe(true)
  })

  it('includes Microsoft tools only when the Microsoft integration is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ integrationStatus: integrationStatus({ microsoftEnabled: true }) }),
    )
    expect(tools.some((tool) => tool.name.startsWith('microsoft'))).toBe(true)
  })

  it('includes Pro tools when the Pro integration is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true } }),
    )
    expect(tools.some((tool) => tool.name === 'search')).toBe(true)
  })
})
