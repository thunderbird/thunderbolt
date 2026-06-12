/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { setMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import '@testing-library/jest-dom'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import OAuthCallback from './oauth-callback'

type OAuthNavState = { oauth?: { error?: string | null } }

// Renders the navigation payload's error so tests can assert both the route
// taken and the error the destination page receives.
const PageProbe = ({ testId }: { testId: string }) => {
  const location = useLocation()
  const oauth = (location.state as OAuthNavState | null)?.oauth
  return <div data-testid={testId}>{oauth?.error}</div>
}

const renderCallback = () =>
  render(
    <MemoryRouter initialEntries={['/oauth/callback']}>
      <Routes>
        <Route path="/oauth/callback" element={<OAuthCallback />} />
        <Route path="/settings/mcp-servers" element={<PageProbe testId="mcp-servers-page" />} />
        <Route path="/settings/integrations" element={<PageProbe testId="integrations-page" />} />
      </Routes>
    </MemoryRouter>,
  )

// The component reads the callback params from window.location.search, not the
// (memory) router location — stub it per test (same pattern as
// post-update-redirect.test.ts) and restore in afterEach.
const originalLocation = window.location
const setCallbackUrl = (query: string) => {
  Object.defineProperty(window, 'location', {
    value: { ...originalLocation, search: query },
    writable: true,
    configurable: true,
  })
}

// Settles the component's 500ms deferred redirect plus the async routing it runs.
const settleDeferredRedirect = async () => {
  await act(async () => {
    getClock().tick(500)
    await getClock().runAllAsync()
  })
}

describe('OAuthCallback routing', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true })
  })

  it('claims a description-only error callback for the pending MCP handshake', async () => {
    // A non-compliant AS may redirect back with error_description but no error
    // param — the MCP claim must use the same coalesced error signal as the
    // navigation payload, or the callback leaks to the integrations flow and the
    // handshake stays pending.
    setMcpOAuthState({ serverId: 'server-1', stateNonce: 'nonce-xyz', startedAt: Date.now() })
    setCallbackUrl('?error_description=User+denied+access')
    renderCallback()

    await settleDeferredRedirect()

    expect(screen.getByTestId('mcp-servers-page')).toHaveTextContent('User denied access')
  })

  it('routes a description-only error to integrations when no MCP handshake is pending', async () => {
    setCallbackUrl('?error_description=User+denied+access')
    renderCallback()

    await settleDeferredRedirect()

    expect(screen.getByTestId('integrations-page')).toHaveTextContent('User denied access')
  })

  it('claims an error-only callback for the pending MCP handshake (existing behavior preserved)', async () => {
    setMcpOAuthState({ serverId: 'server-1', stateNonce: 'nonce-xyz', startedAt: Date.now() })
    setCallbackUrl('?error=access_denied')
    renderCallback()

    await settleDeferredRedirect()

    expect(screen.getByTestId('mcp-servers-page')).toHaveTextContent('access_denied')
  })
})
