/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import {
  disconnectProviderConnection,
  getProviderConnections,
  getProviderCredentials,
  saveProviderConnection,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { createTestProvider } from '@/test-utils/test-provider'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import * as mcpOAuth from '@/lib/mcp-auth/web-oauth-flow'
import { clearMcpOAuthState, setMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import { providerAuthorizationDraftKey, providerAuthorizationDraftStorage } from '@/providers/authorization-draft'
import { getClock } from '@/testing-library'
import { OnboardingSearchStep } from './onboarding-search-step'

beforeAll(setupTestDatabase)
beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)
afterEach(() => {
  cleanup()
  mock.restore()
  useSearchProviderStore.getState().clearSearchProvider()
  clearMcpOAuthState()
  providerAuthorizationDraftStorage().removeItem(providerAuthorizationDraftKey)
})
const next = mock(() => {})
const renderStep = (routerState?: unknown, reactStrictMode = false) => {
  next.mockClear()
  const Provider = createTestProvider()
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[{ pathname: '/chats/new', state: routerState }]}>
      <Provider>{children}</Provider>
    </MemoryRouter>
  )
  return renderWithReactivity(<OnboardingSearchStep onContinue={next} onBack={() => {}} onSkip={() => {}} />, {
    wrapper: Wrapper,
    reactStrictMode,
    tables: ['provider_connections', 'provider_connection_secrets'],
  })
}

/** Model a redirect that returns to the wizard with its saved authorization attempt. */
const prepareOAuthReturn = async () => {
  setMcpOAuthState({ serverId: 'oauth:exa', stateNonce: 'nonce', startedAt: Date.now() })
  providerAuthorizationDraftStorage().setItem(
    providerAuthorizationDraftKey,
    JSON.stringify({
      purpose: 'onboarding-search',
      provider: 'exa',
      name: 'Exa',
      attempt: await getProviderConnectionAttempt(getDb(), 'exa'),
    }),
  )
}

it.each(['disabled', 'disconnected'] as const)(
  'cannot continue with a previously selected %s search connection',
  async (change) => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'exa',
      name: 'Unavailable search',
      authMethod: 'api_key',
      credentials: { apiKey: 'test-key' },
    })
    useSearchProviderStore.getState().selectSearchConnection(id)
    if (change === 'disabled') {
      await updateProviderConnection(getDb(), id, { enabled: false })
    } else {
      await disconnectProviderConnection(getDb(), id)
    }
    renderStep()
    await act(async () => getClock().tickAsync(100))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.queryByRole('radio', { name: 'Unavailable search' })).toBeNull()
    expect(screen.getByRole('radio', { name: 'Exa' })).not.toBeChecked()
    expect(next).not.toHaveBeenCalled()
  },
)

it.each(['access_denied', 'exchange_failed'])(
  'shows an actionable error after an OAuth return: %s',
  async (failure) => {
    await prepareOAuthReturn()
    const exchange = spyOn(mcpOAuth, 'completeMcpOAuthFlow').mockRejectedValue(new Error('Token exchange failed'))
    const retry = spyOn(mcpOAuth, 'startMcpOAuthFlow').mockResolvedValue({ status: 'redirected' })
    renderStep({ oauth: { state: 'nonce', ...(failure === 'access_denied' ? { error: failure } : { code: 'code' }) } })
    expect(await waitForElement(() => screen.queryByRole('alert'))).toHaveTextContent(
      'Could not connect this provider. Please try again.',
    )
    expect(exchange).toHaveBeenCalledTimes(failure === 'exchange_failed' ? 1 : 0)
    fireEvent.click(screen.getByRole('button', { name: 'Connect Exa' }))
    await act(async () => getClock().tickAsync(100))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  },
)

it('ignores a callback for another authorization rather than exchanging its code', async () => {
  await prepareOAuthReturn()
  const exchange = spyOn(mcpOAuth, 'completeMcpOAuthFlow').mockResolvedValue()
  renderStep({ oauth: { state: 'unrelated', code: 'code' } })
  await act(async () => getClock().tickAsync(100))
  expect(exchange).not.toHaveBeenCalled()
  expect(screen.getAllByRole('radio')).toHaveLength(3)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('completes a redirect once under StrictMode effect replay', async () => {
  await prepareOAuthReturn()
  const exchange = spyOn(mcpOAuth, 'completeMcpOAuthFlow').mockImplementation(async (args) => {
    await args.saveCredentials!({
      type: 'oauth',
      access_token: 'access',
      clientId: 'registered',
      issuer: 'https://auth.example',
      tokenEndpoint: 'https://auth.example/token',
    })
  })
  renderStep({ oauth: { state: 'nonce', code: 'code' } }, true)
  expect(await waitForElement(() => screen.queryByText('Connected to Exa'))).toBeVisible()
  expect(exchange).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
})

it('does not publish a late OAuth result after returning to provider choices', async () => {
  await prepareOAuthReturn()
  const exchangeDone = Promise.withResolvers<void>()
  const exchange = spyOn(mcpOAuth, 'completeMcpOAuthFlow').mockImplementation(async (args) => {
    await exchangeDone.promise
    await args.saveCredentials!({
      type: 'oauth',
      access_token: 'late-access',
      clientId: 'registered',
      issuer: 'https://auth.example',
      tokenEndpoint: 'https://auth.example/token',
    })
  })
  renderStep({ oauth: { state: 'nonce', code: 'code' } })
  await act(async () => getClock().tickAsync(100))
  expect(exchange).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
  await act(async () => {
    exchangeDone.resolve()
    await getClock().tickAsync(100)
  })
  expect(screen.getByRole('radio', { name: 'Exa' })).toBeChecked()
  expect(await getProviderConnections(getDb())).toHaveLength(0)
  expect(useSearchProviderStore.getState().connectionId).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['Exa', 'Brave', 'Tavily'])('saves %s via API key and shows one selected provider after Back', async (name) => {
  renderStep()
  expect(screen.getAllByRole('radio')).toHaveLength(3)
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  if (name !== 'Brave') {
    fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
  }
  expect(screen.queryByLabelText('Name')).toBeNull()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Back' })))
  expect(screen.getAllByRole('radio')).toHaveLength(3)
  expect(screen.getAllByRole('radio', { name })).toHaveLength(1)
  expect(screen.getByRole('radio', { name })).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(next).toHaveBeenCalledTimes(1)
  expect(await getProviderConnections(getDb())).toHaveLength(1)
})

it.each(['exa', 'tavily'] as const)(
  'connects %s through OAuth and keeps its existing entry selected',
  async (provider) => {
    spyOn(mcpOAuth, 'startMcpOAuthFlow').mockImplementation(async (args) => {
      await args.saveCredentials!({
        type: 'oauth',
        access_token: 'access',
        refresh_token: 'refresh',
        clientId: 'registered',
        issuer: 'https://auth.example',
        tokenEndpoint: 'https://auth.example/token',
        expires_at: Date.now() + 3600000,
      })
      return { status: 'completed' }
    })
    renderStep()
    const name = provider === 'exa' ? 'Exa' : 'Tavily'
    fireEvent.click(screen.getByRole('radio', { name }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: `Connect ${name}` }))
    expect(await waitForElement(() => screen.queryByText(`Connected to ${name}`))).toBeVisible()
    expect(useSearchProviderStore.getState().connectionId).toBe(`oauth:${provider}`)
    expect(await getProviderCredentials(getDb(), `oauth:${provider}`)).toMatchObject({ access_token: 'access' })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name })).toBeChecked()
  },
)
