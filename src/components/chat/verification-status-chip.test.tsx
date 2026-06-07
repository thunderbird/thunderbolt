/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import type { TinfoilVerification, VerificationStatus } from '@/hooks/use-tinfoil-verification'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { VerificationStatusChip } from './verification-status-chip'

afterEach(() => {
  cleanup()
})

const verification = (status: VerificationStatus): TinfoilVerification => ({
  status,
  doc: null,
  error: null,
  retry: () => {},
})

describe('VerificationStatusChip', () => {
  it('renders nothing when idle (non-Tinfoil model)', () => {
    const { container } = render(<VerificationStatusChip verification={verification('idle')} onOpen={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the verifying state', () => {
    render(<VerificationStatusChip verification={verification('verifying')} onOpen={() => {}} />)
    expect(screen.getByText('Verifying…')).toBeInTheDocument()
  })

  it('shows the verified state', () => {
    render(<VerificationStatusChip verification={verification('verified')} onOpen={() => {}} />)
    expect(screen.getByText('Verified')).toBeInTheDocument()
  })

  it('shows the failed state', () => {
    render(<VerificationStatusChip verification={verification('failed')} onOpen={() => {}} />)
    expect(screen.getByText('Verification failed')).toBeInTheDocument()
  })

  it('calls onOpen when clicked', () => {
    const onOpen = mock(() => {})
    render(<VerificationStatusChip verification={verification('verified')} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
