/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { EntryScreen } from './entry-screen'
import type { DiscoveryResult } from '@/lib/discovery'
import type { ValidationResult } from './mode-picker'

const mockReload = mock()
const mockDiscover = mock<(email: string) => Promise<DiscoveryResult>>()
const mockValidate = mock<(url: string) => Promise<ValidationResult>>()

const renderEntry = () => render(<EntryScreen discover={mockDiscover} validate={mockValidate} reload={mockReload} />)

const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

beforeEach(() => {
  mockReload.mockClear()
  mockDiscover.mockReset()
  mockValidate.mockReset()
  useTrustDomainRegistry.setState({ servers: {}, activeTrustDomain: undefined })
})

afterEach(() => {
  useTrustDomainRegistry.setState({ servers: {}, activeTrustDomain: undefined })
})

describe('EntryScreen', () => {
  it('enters standalone when the advanced card is chosen and Continue clicked', async () => {
    renderEntry()
    fireEvent.click(screen.getByText('Set up my own providers'))
    fireEvent.click(screen.getByText('Continue'))
    await flush()

    expect(useTrustDomainRegistry.getState().activeTrustDomain).toEqual({ kind: 'standalone' })
    expect(mockReload).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid email before hitting discovery', async () => {
    renderEntry()
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'not-an-email' } })
    fireEvent.click(screen.getByRole('button', { name: '' })) // arrow button
    await flush()

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(mockDiscover).not.toHaveBeenCalled()
  })

  it('discovers a server, validates it, and activates the server trust domain', async () => {
    mockDiscover.mockResolvedValue({ ok: true, serverUrl: 'https://acme.thunderbolt.io' })
    mockValidate.mockResolvedValue({ ok: true, serverId: 'srv-1', cloudUrl: 'https://acme.thunderbolt.io/v1' })

    renderEntry()
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'user@acme.com' } })
    fireEvent.keyDown(screen.getByPlaceholderText('you@company.com'), { key: 'Enter' })
    await flush()

    expect(mockDiscover).toHaveBeenCalledWith('user@acme.com')
    expect(mockValidate).toHaveBeenCalledWith('https://acme.thunderbolt.io')
    expect(useTrustDomainRegistry.getState().activeTrustDomain).toEqual({ kind: 'server', serverId: 'srv-1' })
    expect(mockReload).toHaveBeenCalledTimes(1)
  })

  it('surfaces a discovery failure without activating anything', async () => {
    mockDiscover.mockResolvedValue({ ok: false, message: "We couldn't find a server for that email." })

    renderEntry()
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'user@acme.com' } })
    fireEvent.keyDown(screen.getByPlaceholderText('you@company.com'), { key: 'Enter' })
    await flush()

    expect(screen.getByText("We couldn't find a server for that email.")).toBeInTheDocument()
    expect(mockValidate).not.toHaveBeenCalled()
    expect(useTrustDomainRegistry.getState().activeTrustDomain).toBeUndefined()
    expect(mockReload).not.toHaveBeenCalled()
  })
})
