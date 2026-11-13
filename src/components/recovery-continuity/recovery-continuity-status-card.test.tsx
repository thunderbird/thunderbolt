/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { RecoveryContinuityContext, type RecoveryContinuityContextValue } from './recovery-continuity-provider'
import { RecoveryContinuityStatusCard } from './recovery-continuity-status-card'

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

const renderCard = (overrides: Partial<RecoveryContinuityContextValue>, path = '/settings/preferences') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <RecoveryContinuityContext.Provider value={contextWith(overrides)}>
        <RecoveryContinuityStatusCard />
      </RecoveryContinuityContext.Provider>
    </MemoryRouter>,
  )

const card = () => document.getElementById('recovery-phrase-status')
const fact = (term: string) => within(card()!).getByText(term).closest('div')!

const phraseWarning = { status: 'warning', phraseUpdateRequired: true } as const

describe('RecoveryContinuityStatusCard', () => {
  afterEach(cleanup)

  it('is hidden when nothing needs attention', () => {
    renderCard({ passkey: 'protected' })
    expect(card()).toBeNull()
  })

  it('offers the phrase update on a trusted device', () => {
    const start = mock(async () => {})
    renderCard({ ...phraseWarning, start })
    expect(screen.getByText('Recovery phrase needs an update')).toBeInTheDocument()
    expect(fact('This device')).toHaveTextContent('Approved')
    expect(fact('Recovery phrase')).toHaveTextContent('Needs update')
    fireEvent.click(screen.getByRole('button', { name: 'Update recovery phrase' }))
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('keeps the action disabled offline', () => {
    renderCard({ status: 'offline', phraseUpdateRequired: true })
    expect(screen.getByText("You're offline. You can update it once you reconnect.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update recovery phrase' })).toBeDisabled()
  })

  it('sends an untrusted device to an approved one, without a device list it cannot load', () => {
    renderCard({ status: 'untrusted', phraseUpdateRequired: true, deviceTrusted: false })
    expect(fact('This device')).toHaveTextContent('Not approved yet')
    expect(screen.getByText(/Open Thunderbolt on an approved device/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update recovery phrase' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'View devices' })).toBeNull()
  })

  it('explains re-verification on an unverified device, even once the phrase is sealed', () => {
    renderCard({ status: 'unverified', deviceTrusted: false, passkey: 'blocked' })
    expect(screen.getByText("This device couldn't be verified")).toBeInTheDocument()
    expect(screen.getByText(/sign out with "Delete data from device"/)).toBeInTheDocument()
    expect(fact('This device')).toHaveTextContent('Unverified')
    expect(fact('Recovery phrase')).toHaveTextContent('Up to date')
    expect(screen.queryByRole('button', { name: /Update/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'View devices' })).toBeInTheDocument()
  })

  it('offers the passkey update when only the passkey needs one', () => {
    const startPasskeyMigration = mock(async () => {})
    renderCard({ passkey: 'needsUpdate', startPasskeyMigration })
    expect(screen.getByText('Passkey needs an update')).toBeInTheDocument()
    expect(fact('Passkey')).toHaveTextContent('Needs update')
    fireEvent.click(screen.getByRole('button', { name: 'Update passkey' }))
    expect(startPasskeyMigration).toHaveBeenCalledTimes(1)
  })

  it('offers both updates with the phrase title when both need one', () => {
    renderCard({ ...phraseWarning, passkey: 'needsUpdate' })
    expect(screen.getByText('Recovery phrase needs an update')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update recovery phrase' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update passkey' })).toBeInTheDocument()
  })

  it('shows a blocked passkey without an action', () => {
    renderCard({ passkey: 'blocked', deviceTrusted: false })
    expect(fact('Passkey')).toHaveTextContent('Needs update')
    expect(screen.queryByRole('button', { name: 'Update passkey' })).toBeNull()
  })

  it('shows the passkey error and keeps the action for a retry', () => {
    renderCard({
      passkey: 'needsUpdate',
      passkeyMigration: { busy: false, errorMessage: "The passkey check was cancelled. Try again when you're ready." },
    })
    expect(screen.getByText("The passkey check was cancelled. Try again when you're ready.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update passkey' })).toBeEnabled()
  })

  it('reports a protected passkey', () => {
    renderCard({ ...phraseWarning, passkey: 'protected' })
    expect(fact('Passkey')).toHaveTextContent('Protected')
  })

  it.each([
    ['updatedHere', 'Recovery phrase updated'],
    ['updatedElsewhere', 'Updated on another device'],
    ['passkeyUpdated', 'Passkey updated'],
  ] as const)('announces %s with Got it', (notice, title) => {
    const dismissNotice = mock(() => {})
    renderCard({ notice, dismissNotice, passkey: notice === 'passkeyUpdated' ? 'protected' : 'none' })
    expect(screen.getByText(title)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(dismissNotice).toHaveBeenCalledTimes(1)
  })

  it('offers Review devices after an update elsewhere', () => {
    renderCard({ notice: 'updatedElsewhere' })
    expect(screen.getByRole('button', { name: 'Review devices' })).toBeInTheDocument()
  })

  it('focuses its title from the deep link, clear of the floating header', () => {
    renderCard(phraseWarning, '/settings/preferences#recovery-phrase-status')
    expect(document.activeElement).toHaveTextContent('Recovery phrase needs an update')
    // scrollIntoView aligns the title to the scroll container's top, where the
    // floating header overlays the page; the margin keeps it in view below.
    expect(document.activeElement).toHaveClass('scroll-mt-[var(--header-inset)]')
  })
})
