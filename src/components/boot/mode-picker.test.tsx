/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { ModePicker } from './mode-picker'

// --- Module mocks ---

const mockClientJson = mock()
const mockClientGet = mock(() => ({ json: mockClientJson }))

const MockHttpError = class HttpError extends Error {
  response: Response
  constructor(response: Response) {
    super(`Request failed with status ${response.status}`)
    this.name = 'HttpError'
    this.response = response
  }
}

mock.module('@/lib/http', () => ({
  createClient: mock(() => ({ get: mockClientGet })),
  HttpError: MockHttpError,
}))

// --- window.location.reload mock ---

const mockReload = mock()

beforeEach(() => {
  // @ts-expect-error — jsdom does not allow overwriting location directly
  delete window.location
  // @ts-expect-error — jsdom does not allow overwriting location directly
  window.location = { ...window.location, reload: mockReload }

  mockClientGet.mockClear()
  mockClientJson.mockClear()
  mockReload.mockClear()

  useTrustDomainRegistry.setState({ servers: {}, activeTrustDomain: undefined })
})

afterEach(() => {
  useTrustDomainRegistry.setState({ servers: {}, activeTrustDomain: undefined })
})

// Helper: flush all pending async work (promises + fake timers) inside act
const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('ModePicker', () => {
  describe('initial render', () => {
    it('shows both option cards', () => {
      render(<ModePicker />)

      expect(screen.getByText('Set up an on-device agent')).toBeInTheDocument()
      expect(screen.getByText('Connect to AI server')).toBeInTheDocument()
    })

    it('Continue (arrow) is disabled when nothing is selected', () => {
      render(<ModePicker />)

      const buttons = screen.getAllByRole('button')
      const arrowBtn = buttons[buttons.length - 1]
      expect(arrowBtn).toBeDisabled()
    })

    it('does not show URL input on initial render', () => {
      render(<ModePicker />)

      expect(screen.queryByPlaceholderText('app.thunderbolt.io/')).not.toBeInTheDocument()
    })
  })

  describe('standalone selection', () => {
    it('enables Continue after selecting standalone', () => {
      render(<ModePicker />)

      fireEvent.click(screen.getByText('Set up an on-device agent'))

      const buttons = screen.getAllByRole('button')
      expect(buttons[buttons.length - 1]).not.toBeDisabled()
    })

    it('Skip writes activateStandalone and reloads', () => {
      render(<ModePicker />)

      fireEvent.click(screen.getByRole('button', { name: /skip/i }))

      expect(useTrustDomainRegistry.getState().activeTrustDomain).toEqual({ kind: 'standalone' })
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('Continue with standalone writes activateStandalone and reloads', () => {
      render(<ModePicker />)

      fireEvent.click(screen.getByText('Set up an on-device agent'))

      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[buttons.length - 1])

      expect(useTrustDomainRegistry.getState().activeTrustDomain).toEqual({ kind: 'standalone' })
      expect(mockReload).toHaveBeenCalledTimes(1)
    })
  })

  describe('server selection', () => {
    it('reveals URL input when server card is clicked', () => {
      render(<ModePicker />)

      fireEvent.click(screen.getByText('Connect to AI server'))

      expect(screen.getByPlaceholderText('app.thunderbolt.io/')).toBeInTheDocument()
      expect(screen.getByText("Enter Server's URL:")).toBeInTheDocument()
    })

    it('Continue is disabled when server is selected but URL is empty', () => {
      render(<ModePicker />)

      fireEvent.click(screen.getByText('Connect to AI server'))

      const buttons = screen.getAllByRole('button')
      expect(buttons[buttons.length - 1]).toBeDisabled()
    })

    it('Continue enables once a URL is typed', () => {
      render(<ModePicker />)

      fireEvent.click(screen.getByText('Connect to AI server'))
      fireEvent.change(screen.getByPlaceholderText('app.thunderbolt.io/'), {
        target: { value: 'http://localhost:8000' },
      })

      const buttons = screen.getAllByRole('button')
      expect(buttons[buttons.length - 1]).not.toBeDisabled()
    })
  })

  describe('blur validation', () => {
    it('shows a checkmark on successful blur validation', async () => {
      mockClientJson.mockResolvedValue({ serverId: 'test-server-id' })

      render(<ModePicker />)
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://localhost:8000' } })
      fireEvent.blur(input)

      await flush()

      // A Check icon should appear inside the input wrapper
      expect(input.parentElement?.querySelector('svg')).toBeInTheDocument()
    })

    it('shows "Couldn\'t reach" error on network failure during blur', async () => {
      mockClientJson.mockRejectedValue(new Error('Network error'))

      render(<ModePicker />)
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://unreachable.local' } })
      fireEvent.blur(input)

      await flush()

      expect(screen.getByText("Couldn't reach this server")).toBeInTheDocument()
    })

    it('shows "doesn\'t look like" error on HTTP error response during blur', async () => {
      const fakeResponse = new Response('Not found', { status: 404 })
      mockClientJson.mockRejectedValue(new MockHttpError(fakeResponse))

      render(<ModePicker />)
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://not-thunderbolt.local' } })
      fireEvent.blur(input)

      await flush()

      expect(screen.getByText("This URL doesn't look like a Thunderbolt server")).toBeInTheDocument()
    })

    it('shows "doesn\'t look like" error when 200 response is missing serverId', async () => {
      mockClientJson.mockResolvedValue({ e2eeEnabled: true }) // valid JSON but no serverId

      render(<ModePicker />)
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://wrong-server.local' } })
      fireEvent.blur(input)

      await flush()

      expect(screen.getByText("This URL doesn't look like a Thunderbolt server")).toBeInTheDocument()
    })
  })

  describe('Continue with server (submit-time validation)', () => {
    it('writes activateServer and reloads on valid URL', async () => {
      const serverId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      mockClientJson.mockResolvedValue({ serverId })

      render(<ModePicker />)
      fireEvent.click(screen.getByText('Connect to AI server'))
      fireEvent.change(screen.getByPlaceholderText('app.thunderbolt.io/'), {
        target: { value: 'http://localhost:8000' },
      })

      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[buttons.length - 1])

      await flush()

      expect(mockReload).toHaveBeenCalledTimes(1)
      const registry = useTrustDomainRegistry.getState()
      expect(registry.activeTrustDomain).toEqual({ kind: 'server', serverId })
      expect(registry.servers[serverId]?.cloudUrl).toBe('http://localhost:8000/v1')
    })

    it('strips trailing /v1 from user URL when building cloudUrl', async () => {
      const serverId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      mockClientJson.mockResolvedValue({ serverId })

      render(<ModePicker />)
      fireEvent.click(screen.getByText('Connect to AI server'))
      fireEvent.change(screen.getByPlaceholderText('app.thunderbolt.io/'), {
        target: { value: 'http://localhost:8000/v1' }, // user pastes the API-prefixed URL
      })

      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[buttons.length - 1])

      await flush()

      // should not double-append /v1 → cloudUrl stays http://localhost:8000/v1
      expect(useTrustDomainRegistry.getState().servers[serverId]?.cloudUrl).toBe('http://localhost:8000/v1')
    })

    it('shows inline error and returns to picker on validation failure', async () => {
      mockClientJson.mockRejectedValue(new Error('Network error'))

      render(<ModePicker />)
      fireEvent.click(screen.getByText('Connect to AI server'))
      fireEvent.change(screen.getByPlaceholderText('app.thunderbolt.io/'), {
        target: { value: 'http://unreachable.local' },
      })

      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[buttons.length - 1])

      await flush()

      expect(screen.getByText("Couldn't reach this server")).toBeInTheDocument()
      expect(mockReload).not.toHaveBeenCalled()
      // Picker heading should still be visible (not the connecting screen)
      expect(screen.getByText('How would you like to use Thunderbolt?')).toBeInTheDocument()
    })
  })

  describe('URL normalization', () => {
    const serverId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    const testNormalization = async (input: string, expectedCloudUrl: string) => {
      mockClientJson.mockResolvedValue({ serverId })

      render(<ModePicker />)
      fireEvent.click(screen.getByText('Connect to AI server'))
      fireEvent.change(screen.getByPlaceholderText('app.thunderbolt.io/'), { target: { value: input } })

      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[buttons.length - 1])

      await flush()

      expect(useTrustDomainRegistry.getState().servers[serverId]?.cloudUrl).toBe(expectedCloudUrl)
      useTrustDomainRegistry.setState({ servers: {}, activeTrustDomain: undefined })
    }

    it('handles bare hostname: app.thunderbolt.io', async () => {
      await testNormalization('app.thunderbolt.io', 'https://app.thunderbolt.io/v1')
    })

    it('handles bare hostname with trailing slash: app.thunderbolt.io/', async () => {
      await testNormalization('app.thunderbolt.io/', 'https://app.thunderbolt.io/v1')
    })

    it('handles http:// URL: http://app.thunderbolt.io', async () => {
      await testNormalization('http://app.thunderbolt.io', 'http://app.thunderbolt.io/v1')
    })

    it('handles https:// URL with trailing slash: https://app.thunderbolt.io/', async () => {
      await testNormalization('https://app.thunderbolt.io/', 'https://app.thunderbolt.io/v1')
    })

    it('uses http:// for bare localhost: localhost:8000', async () => {
      await testNormalization('localhost:8000', 'http://localhost:8000/v1')
    })

    it('uses http:// for bare localhost without port: localhost', async () => {
      await testNormalization('localhost', 'http://localhost/v1')
    })

    it('uses http:// for bare 127.0.0.1: 127.0.0.1:8000', async () => {
      await testNormalization('127.0.0.1:8000', 'http://127.0.0.1:8000/v1')
    })
  })
})
