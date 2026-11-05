/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { I18nProvider } from '@lingui/react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { i18n } from '@/i18n'
import { getClock } from '@/testing-library'
import type { OpenRouterCallbackChannel } from '@/lib/openrouter-callback'
import OpenRouterCallback from './openrouter-callback'

const flowId = 'a'.repeat(43)
const originalLocation = window.location

/** Renders a returned popup with no opener and an isolated channel boundary. */
const renderCallback = (query: string, path = `/oauth/openrouter/${flowId}`) => {
  const callbackUrl = new URL(`https://app.test${path}${query}`)
  Object.defineProperty(window, 'location', { value: callbackUrl, configurable: true, writable: true })
  spyOn(window.history, 'replaceState').mockImplementation((_state, _unused, url) => {
    Object.defineProperty(window, 'location', {
      value: new URL(String(url), callbackUrl),
      configurable: true,
      writable: true,
    })
  })
  const postMessage = mock(() => {})
  const close = mock(() => {})
  const channel: OpenRouterCallbackChannel = { onmessage: null, postMessage, close }
  const createChannel = mock(() => channel)
  const closeWindow = spyOn(window, 'close').mockImplementation(() => {})
  const view = render(
    <I18nProvider i18n={i18n}>
      <OpenRouterCallback createChannel={createChannel} />
    </I18nProvider>,
  )
  return { ...view, postMessage, close, createChannel, closeWindow }
}

afterEach(() => {
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
  mock.restore()
})

describe('OpenRouter callback without a window opener', () => {
  it('relays across the flow channel, clears sensitive URL parameters, and closes itself', async () => {
    expect(window.opener ?? null).toBeNull()
    const view = renderCallback(`?code=authorization-code&state=${flowId}#discard`)
    expect(view.createChannel).toHaveBeenCalledWith(`thunderbolt-openrouter-${flowId}`)
    expect(view.postMessage).toHaveBeenCalledWith({
      type: 'openrouter-callback',
      state: flowId,
      code: 'authorization-code',
    })
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')
    expect(screen.getByRole('heading')).toHaveTextContent('Return to Thunderbolt')
    await act(async () => getClock().tickAsync(1000))
    expect(view.closeWindow).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(view.close).toHaveBeenCalledTimes(1)
  })

  it('relays a sanitized denial even when OpenRouter omits state', () => {
    const view = renderCallback('?error=access_denied&error_description=private-provider-message')
    expect(view.postMessage).toHaveBeenCalledWith({ type: 'openrouter-callback', state: flowId, error: 'cancelled' })
    expect(screen.getByRole('heading')).toHaveTextContent('Connection not completed')
    expect(screen.queryByText('private-provider-message')).not.toBeInTheDocument()
    expect(screen.getByText('Connection cancelled')).toBeInTheDocument()
    expect(screen.queryByText('Ready to continue')).not.toBeInTheDocument()
  })

  it('does not relay an authorization code with mismatched state and cancels the close timer on unmount', async () => {
    const view = renderCallback('?code=authorization-code&state=wrong')
    expect(view.postMessage).toHaveBeenCalledWith({
      type: 'openrouter-callback',
      state: flowId,
      error: 'invalid_response',
    })
    view.unmount()
    await act(async () => getClock().tickAsync(1000))
    expect(view.closeWindow).not.toHaveBeenCalled()
    expect(view.close).toHaveBeenCalledTimes(1)
  })

  it('offers a manual close action without navigating away', () => {
    const view = renderCallback(`?code=authorization-code&state=${flowId}`)
    expect(screen.getByText('Ready to continue')).toBeInTheDocument()
    expect(screen.getByText('Continue in your Thunderbolt window')).toBeInTheDocument()
    expect(window.location.pathname).toBe(`/oauth/openrouter/${flowId}`)
    expect(window.location.search).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Close this window' }))
    expect(view.closeWindow).toHaveBeenCalledTimes(1)
    expect(view.postMessage).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('explains an incomplete link without relaying or closing automatically', async () => {
    const view = renderCallback('', '/oauth/openrouter')
    expect(screen.getByRole('heading')).toHaveTextContent('Connection not completed')
    expect(screen.getByText(/This connection link is no longer valid/)).toBeInTheDocument()
    expect(view.createChannel).not.toHaveBeenCalled()
    await act(async () => getClock().tickAsync(1000))
    expect(view.closeWindow).not.toHaveBeenCalled()
  })
})
