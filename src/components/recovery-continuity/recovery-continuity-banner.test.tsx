/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMobileForegroundPortalTarget } from '@/components/ui/mobile-foreground-portal'
import { SidebarProvider } from '@/components/ui/sidebar'
import { cleanup, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { RecoveryContinuityBanner, RecoveryContinuityColumn } from './recovery-continuity-banner'
import { RecoveryContinuityContext, type RecoveryContinuityContextValue } from './recovery-continuity-provider'

const contextWith = (overrides: Partial<RecoveryContinuityContextValue>): RecoveryContinuityContextValue => ({
  status: 'hidden',
  phraseUpdateRequired: false,
  passkey: 'none',
  notice: 'none',
  deviceTrusted: true,
  passkeyMigration: { busy: false, errorMessage: null },
  start: async () => {},
  startPasskeyMigration: async () => {},
  dismissNotice: () => {},
  ...overrides,
})

const renderWith = (overrides: Partial<RecoveryContinuityContextValue>, children = <RecoveryContinuityBanner />) =>
  render(
    <MemoryRouter>
      <SidebarProvider>
        <RecoveryContinuityContext.Provider value={contextWith(overrides)}>
          {children}
        </RecoveryContinuityContext.Provider>
      </SidebarProvider>
    </MemoryRouter>,
  )

const banner = () => screen.queryByRole('region', { name: 'Security notice' })

describe('RecoveryContinuityBanner', () => {
  afterEach(cleanup)

  it('warns a trusted device with an Update now action', () => {
    renderWith({ status: 'warning' })
    expect(banner()).toBeInTheDocument()
    expect(screen.getByText('Update your recovery phrase.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('keeps the warning offline with the action disabled', () => {
    renderWith({ status: 'offline' })
    expect(screen.getByText("You're offline. You can update it once you reconnect.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled()
  })

  it('announces a phrase change on this device with a dismiss button', () => {
    renderWith({ notice: 'updatedHere' })
    expect(screen.getByText('Recovery phrase updated.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('announces a phrase change on another device with Review devices', () => {
    renderWith({ notice: 'updatedElsewhere' })
    expect(screen.getByText('Your recovery phrase was updated on another device.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review devices' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it.each([
    ['hidden', {}],
    ['untrusted', { status: 'untrusted', deviceTrusted: false }],
    ['unverified', { status: 'unverified', deviceTrusted: false }],
    ['a notice on an untrusted device', { notice: 'updatedElsewhere', deviceTrusted: false }],
    ['the passkey alone', { passkey: 'needsUpdate' }],
  ] as const)('renders nothing when %s', (_label, overrides) => {
    renderWith(overrides)
    expect(banner()).toBeNull()
  })
})

describe('RecoveryContinuityColumn', () => {
  afterEach(cleanup)

  const column = () => screen.getByTestId('column-content').parentElement!

  it('moves the header below the banner while it shows', () => {
    renderWith(
      { status: 'warning' },
      <RecoveryContinuityColumn>
        <p data-testid="column-content" />
      </RecoveryContinuityColumn>,
    )
    expect(column().style.getPropertyValue('--header-safe-area-top')).toBe('0px')
  })

  // Mobile page titles and the search button are `fixed` and portaled: they
  // must land in the column, which contains them below the banner.
  const PortaledChrome = () => {
    const target = useMobileForegroundPortalTarget()
    return target ? createPortal(<span data-testid="portaled-chrome" />, target) : null
  }

  it('contains portaled page chrome below the banner while it shows', () => {
    renderWith(
      { status: 'warning' },
      <RecoveryContinuityColumn>
        <p data-testid="column-content" />
        <PortaledChrome />
      </RecoveryContinuityColumn>,
    )
    expect(column().contains(screen.getByTestId('portaled-chrome'))).toBe(true)
    expect(column().className).toContain('max-md:[contain:layout]')
  })

  it('adds no containment without a banner', () => {
    renderWith(
      {},
      <RecoveryContinuityColumn>
        <p data-testid="column-content" />
      </RecoveryContinuityColumn>,
    )
    expect(column().className).not.toContain('contain')
  })

  it('leaves the header variables alone without a banner', () => {
    renderWith(
      {},
      <RecoveryContinuityColumn>
        <p data-testid="column-content" />
      </RecoveryContinuityColumn>,
    )
    expect(column().style.getPropertyValue('--header-safe-area-top')).toBe('')
  })
})
