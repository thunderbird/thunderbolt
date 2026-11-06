/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { AttestationControl } from './attestation-control'
import type { AttestationState } from '@/attestation/types'
import type { AttestationTarget } from '@/attestation/target'

const target: AttestationTarget = { kind: 'local', key: 'tinfoil:user', provider: 'Tinfoil', client: 'user' }
const verified: AttestationState = {
  status: 'verified',
  evidence: {
    provider: 'Tinfoil',
    verifiedAt: Date.now(),
    endpoint: 'router.tinfoil.sh',
    checks: ['hardware', 'code', 'measurement', 'channel'],
    details: [{ label: 'release', value: 'release-digest' }],
  },
}

describe('attestation control', () => {
  it('keeps technical details behind a disclosure and makes the inference boundary explicit', () => {
    render(<AttestationControl target={target} state={verified} onVerify={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Connection verified' }))
    expect(screen.getByText('Hardware attestation')).toBeVisible()
    expect(screen.getByText('Signed build provenance')).toBeVisible()
    expect(screen.getByText('Enclave-bound encryption key')).toBeVisible()
    expect(screen.getByText(/Verification covers model inference/)).toBeVisible()
    const details = screen.getByText('Connection details').closest('details')
    expect(details).not.toHaveAttribute('open')
    expect(screen.getByText('release-digest')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify connection' })).not.toBeInTheDocument()
  })

  it('does not verify just by opening the panel; verifies on the explicit action', () => {
    const verify = mock(async () => {})
    render(<AttestationControl target={target} state={{ status: 'idle' }} onVerify={verify} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Private inference' }))
    expect(verify).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Verify connection' }))
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('removes success details on failure and offers a retry without raw SDK errors', () => {
    const view = render(<AttestationControl target={target} state={verified} onVerify={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Connection verified' }))
    view.rerender(
      <AttestationControl target={target} state={{ status: 'failed', reason: 'timeout' }} onVerify={async () => {}} />,
    )
    expect(screen.queryByText('Hardware attestation')).not.toBeInTheDocument()
    expect(screen.queryByText('release-digest')).not.toBeInTheDocument()
    expect(screen.getByText(/Verification timed out/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  it('never displays local evidence for an ACP agent, even if supplied accidentally', () => {
    render(
      <AttestationControl
        target={{ kind: 'agent', key: 'agent:remote', name: 'My agent' }}
        state={verified}
        onVerify={async () => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Agent privacy' }))
    expect(screen.getByText(/My agent receives this chat/)).toBeVisible()
    expect(screen.queryByText('Connection verified')).not.toBeInTheDocument()
    expect(screen.queryByText('Hardware attestation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify connection' })).not.toBeInTheDocument()
  })
  it.each([
    ['verification', 'The connection could not be verified.'],
    ['timeout', 'Verification timed out.'],
  ] as const)('allows retry after %s and replaces failure with the pending state', (reason, message) => {
    const verify = mock(async () => {})
    const view = render(<AttestationControl target={target} state={{ status: 'failed', reason }} onVerify={verify} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Verification failed' }))
    expect(screen.getByText(new RegExp(message))).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(verify).toHaveBeenCalledTimes(1)
    view.rerender(<AttestationControl target={target} state={{ status: 'verifying' }} onVerify={verify} />)
    expect(screen.getByRole('heading', { name: 'Verifying connection…' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.queryByText('Hardware attestation')).not.toBeInTheDocument()
  })

  it('never displays a verification result or verify action for an unsupported provider', () => {
    render(
      <AttestationControl
        target={{ kind: 'unsupported', key: 'unsupported:custom' }}
        state={verified}
        onVerify={async () => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Verification unavailable' }))
    expect(screen.getByText(/cannot verify its provider yet/)).toBeVisible()
    expect(screen.queryByText('Hardware attestation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify connection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Connection verified' })).not.toBeInTheDocument()
  })

  it('returns focus to the persistent trigger when the dialog closes', async () => {
    render(<AttestationControl target={target} state={verified} onVerify={async () => {}} />)
    const trigger = screen.getByRole('button', { name: 'Connection privacy: Connection verified' })
    await act(async () => {
      fireEvent.click(trigger)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    })
    await waitForElement(() => (document.activeElement === trigger ? trigger : null))
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
