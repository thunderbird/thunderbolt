/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The WS relay's auth contract mirrors Haystack's (covered in haystack/routes.test.ts:
 * bearer in `Sec-WebSocket-Protocol`, validated in `open()`), and the relay pipe +
 * owner gate are unit-tested in relay.test.ts / e2b.test.ts. What's unique here is
 * the wiring: mounting the routes must register the provider so `/v1/agents/*`
 * (deploy/catalog/status) route to OpenClaw.
 */

import { getProviderById } from '@/agents'
import { resetAgentProvidersForTesting } from '@/agents/discovery'
import type { Auth } from '@/auth/elysia-plugin'
import { createTestSettings } from '@/test-utils/settings'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createOpenclawRoutes } from './routes'

const mockAuth = {} as Auth

describe('createOpenclawRoutes', () => {
  beforeEach(() => resetAgentProvidersForTesting())

  test('registers the openclaw provider with deploy/catalog/status verbs', () => {
    expect(getProviderById('openclaw')).toBeUndefined()

    createOpenclawRoutes(createTestSettings(), mockAuth)

    const provider = getProviderById('openclaw')
    expect(provider?.id).toBe('openclaw')
    expect(provider?.catalog).toBeDefined()
    expect(provider?.deploy).toBeDefined()
    expect(provider?.status).toBeDefined()
  })
})
