/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { ModePicker, type ValidateServerUrlFn, type ValidationResult } from './mode-picker'

// --- Injected validator (DI) ---
//
// The `validate` prop replaces the previous `mock.module('@/lib/http', ...)`
// shim. That global module mock leaked across test files because it only
// shipped `createClient`/`HttpError` — downstream tests that imported other
// `@/lib/http` exports (or expected a fully-featured HttpClient back from
// `createClient`) crashed. DI keeps the mock scoped to this file.
const mockValidate = mock<ValidateServerUrlFn>(async () => ({ ok: false, message: 'not configured' }))

const renderModePicker = () => render(<ModePicker validate={mockValidate} />)

// --- window.location.reload mock ---

const mockReload = mock()

beforeEach(() => {
  // @ts-expect-error — jsdom does not allow overwriting location directly
  delete window.location
  // @ts-expect-error — jsdom does not allow overwriting location directly
  window.location = { ...window.location, reload: mockReload }

  mockValidate.mockClear()
  // Default to a failing validation so accidental real-network calls don't blow up.
  mockValidate.mockImplementation(async () => ({ ok: false, message: 'not configured' }))
  mockReload.mockClear()

  useTrustDomainRegistry.setState({ servers: {}, activeTrustDomain: undefined })
})

afterEach(() => {
  useTrustDomainRegistry.setState({ servers: {}, activeTrustDomain: undefined })
})

const okValidation = (overrides: Partial<Extract<ValidationResult, { ok: true }>> = {}) => ({
  ok: true as const,
  serverId: 'test-server-id',
  cloudUrl: 'http://localhost:8000/v1',
  ...overrides,
})

const errorValidation = (message: string): ValidationResult => ({ ok: false, message })

// Helper: flush all pending async work (promises + fake timers) inside act
const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('ModePicker', () => {
  describe('initial render', () => {
    it('shows both option cards', () => {
      renderModePicker()

      expect(screen.getByText('Set up an on-device agent')).toBeInTheDocument()
      expect(screen.getByText('Connect to AI server')).toBeInTheDocument()
    })

    it('Continue (arrow) is disabled on initial render (server selected, URL empty)', () => {
      renderModePicker()

      const buttons = screen.getAllByRole('button')
      const arrowBtn = buttons[buttons.length - 1]
      expect(arrowBtn).toBeDisabled()
    })

    it('shows URL input on initial render (server is the default selection)', () => {
      renderModePicker()

      expect(screen.getByPlaceholderText('app.thunderbolt.io/')).toBeInTheDocument()
    })
  })

  describe('standalone selection (Skip-only flow)', () => {
    // The "Set up an on-device agent" card is a disabled placeholder in the
    // current UI — the only path into standalone mode is the Skip button.
    it('Skip writes activateStandalone and reloads', () => {
      renderModePicker()

      fireEvent.click(screen.getByRole('button', { name: /skip/i }))

      expect(useTrustDomainRegistry.getState().activeTrustDomain).toEqual({ kind: 'standalone' })
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('standalone card is disabled (placeholder for future on-device agent flow)', () => {
      renderModePicker()

      const standaloneCard = screen.getByText('Set up an on-device agent').closest('button')
      expect(standaloneCard).toBeDisabled()
    })
  })

  describe('server selection', () => {
    it('reveals URL input when server card is clicked', () => {
      renderModePicker()

      fireEvent.click(screen.getByText('Connect to AI server'))

      expect(screen.getByPlaceholderText('app.thunderbolt.io/')).toBeInTheDocument()
      expect(screen.getByText("Enter Server's URL:")).toBeInTheDocument()
    })

    it('Continue is disabled when server is selected but URL is empty', () => {
      renderModePicker()

      fireEvent.click(screen.getByText('Connect to AI server'))

      const buttons = screen.getAllByRole('button')
      expect(buttons[buttons.length - 1]).toBeDisabled()
    })

    it('Continue enables once a URL is typed', () => {
      renderModePicker()

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
      mockValidate.mockResolvedValue(okValidation())

      renderModePicker()
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://localhost:8000' } })
      fireEvent.blur(input)

      await flush()

      // A Check icon should appear inside the input wrapper
      expect(input.parentElement?.querySelector('svg')).toBeInTheDocument()
    })

    it('shows "Couldn\'t reach" error on validate failure during blur', async () => {
      mockValidate.mockResolvedValue(errorValidation("Couldn't reach this server"))

      renderModePicker()
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://unreachable.local' } })
      fireEvent.blur(input)

      await flush()

      expect(screen.getByText("Couldn't reach this server")).toBeInTheDocument()
    })

    it('shows "doesn\'t look like" error on validate failure during blur', async () => {
      mockValidate.mockResolvedValue(errorValidation("This URL doesn't look like a Thunderbolt server"))

      renderModePicker()
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://not-thunderbolt.local' } })
      fireEvent.blur(input)

      await flush()

      expect(screen.getByText("This URL doesn't look like a Thunderbolt server")).toBeInTheDocument()
    })
  })

  describe('Continue with server (submit-time validation)', () => {
    it('writes activateServer and reloads on valid validate result', async () => {
      const serverId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      mockValidate.mockResolvedValue(okValidation({ serverId, cloudUrl: 'http://localhost:8000/v1' }))

      renderModePicker()
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

    it('passes the raw user URL through to validate (URL normalization is its responsibility)', async () => {
      mockValidate.mockResolvedValue(okValidation())

      renderModePicker()
      fireEvent.click(screen.getByText('Connect to AI server'))
      fireEvent.change(screen.getByPlaceholderText('app.thunderbolt.io/'), {
        target: { value: 'http://localhost:8000/v1' },
      })

      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[buttons.length - 1])

      await flush()

      // Submit-time: handleContinue forwards the raw URL to validate; tests of
      // normalizeBaseUrl behavior live alongside `validateServerUrl` directly.
      expect(mockValidate).toHaveBeenCalledWith('http://localhost:8000/v1')
    })

    it('does not leave Continue stuck disabled after a stale blur + edit', async () => {
      let resolveValidate: (r: ValidationResult) => void = () => {}
      mockValidate.mockImplementation(
        () =>
          new Promise<ValidationResult>((resolve) => {
            resolveValidate = resolve
          }),
      )

      renderModePicker()
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://stale.local' } })
      fireEvent.blur(input)
      // Edit before validate() resolves — isValidating must clear so Continue
      // enables once a non-empty URL is in the field.
      fireEvent.change(input, { target: { value: 'http://fresh.local' } })

      resolveValidate(okValidation())
      await flush()

      const buttons = screen.getAllByRole('button')
      expect((buttons[buttons.length - 1] as HTMLButtonElement).disabled).toBe(false)
    })

    it('drops a stale blur result when the user edits the field during validation', async () => {
      // Hold validate() pending so we can interleave a SET_URL between
      // dispatch(VALIDATE_START) and the result.
      let resolveValidate: (r: ValidationResult) => void = () => {}
      mockValidate.mockImplementation(
        () =>
          new Promise<ValidationResult>((resolve) => {
            resolveValidate = resolve
          }),
      )

      renderModePicker()
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://stale.local' } })
      fireEvent.blur(input)
      // No flush yet — validate() is still pending.

      // User edits the field while validate is in flight.
      fireEvent.change(input, { target: { value: 'http://fresh.local' } })

      // Stale validate finally resolves with success for the OLD URL.
      resolveValidate(okValidation())
      await flush()

      // Checkmark must NOT appear — the success was for stale text.
      expect(input.parentElement?.querySelector('svg')).not.toBeInTheDocument()
    })

    it('reuses the blur-time validation when Continue submits the same URL', async () => {
      const serverId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      mockValidate.mockResolvedValue(okValidation({ serverId }))

      renderModePicker()
      fireEvent.click(screen.getByText('Connect to AI server'))

      const input = screen.getByPlaceholderText('app.thunderbolt.io/')
      fireEvent.change(input, { target: { value: 'http://localhost:8000' } })
      fireEvent.blur(input)
      await flush()

      // Blur fires one validate call.
      expect(mockValidate).toHaveBeenCalledTimes(1)

      // Continue against the SAME URL must not re-validate.
      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[buttons.length - 1])
      await flush()

      expect(mockValidate).toHaveBeenCalledTimes(1)
      expect(useTrustDomainRegistry.getState().activeTrustDomain).toEqual({ kind: 'server', serverId })
    })

    it('shows inline error and returns to picker on validation failure', async () => {
      mockValidate.mockResolvedValue(errorValidation("Couldn't reach this server"))

      renderModePicker()
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
})
