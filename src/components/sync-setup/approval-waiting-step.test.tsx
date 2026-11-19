/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { deriveApprovalCode } from '@/crypto/device-approval-code'
import { getClock } from '@/testing-library'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import type { ReactNode } from 'react'
import { ApprovalWaitingStep } from './approval-waiting-step'

const challenge = 'a'.repeat(64)
const getApprovalCodeContext = async (sessionId: string) => `context:${sessionId}`

/**
 * Relay stand-in: `available: false` models an older backend without the approval-session routes;
 * `failStart` makes starting a session fail with a 500 until the test clears it.
 */
const createRelay = (available: boolean, failStart: boolean) => {
  const relay = { sessionId: '', reveal: '', challenged: false, failStart }
  const { httpClient } = createSpyHttpClient(async (request) => {
    const path = new URL(request.url).pathname
    if (!available) {
      return jsonResponse({ error: 'Not found' }, 404)
    }
    if (request.method === 'POST' && path.endsWith('/approval-session')) {
      if (relay.failStart) {
        return jsonResponse({ error: 'Internal error' }, 500)
      }
      relay.sessionId = (await request.json()).sessionId
      return new Response(null, { status: 204 })
    }
    if (request.method === 'POST' && path.endsWith('/approval-session/reveal')) {
      relay.reveal = (await request.json()).reveal
      return new Response(null, { status: 204 })
    }
    return jsonResponse({
      sessionId: relay.sessionId,
      challenge: relay.challenged ? challenge : null,
      challengerDeviceId: relay.challenged ? 'trusted-1' : null,
      expired: false,
    })
  })
  return { relay, httpClient }
}

const settleUntil = async (done: () => boolean, timeoutMs = 5000) => {
  // performance.now() is not faked, so this budget is real time even with the fake clock installed.
  const deadline = performance.now() + timeoutMs
  while (!done() && performance.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve))
    })
  }
}

describe('ApprovalWaitingStep', () => {
  afterEach(() => cleanup())

  type StepOptions = {
    onUnlockWithPasskey?: () => void
    available?: boolean
    failStart?: boolean
    error?: string | null
    onContinue?: () => void
  }

  const renderStep = ({
    onUnlockWithPasskey,
    available = true,
    failStart = false,
    error = null,
    onContinue,
  }: StepOptions = {}) => {
    const { relay, httpClient } = createRelay(available, failStart)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <HttpClientProvider httpClient={httpClient}>{children}</HttpClientProvider>
    )
    render(
      <ApprovalWaitingStep
        fingerprint="FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680-CD9B-98EE-0A09-C5B4-A48D-212E-295B-CA2C"
        error={error}
        onContinue={onContinue ?? (() => {})}
        onUseRecoveryKey={() => {}}
        onUnlockWithPasskey={onUnlockWithPasskey}
        getApprovalCodeContext={getApprovalCodeContext}
      />,
      { wrapper },
    )
    return relay
  }

  it('shows the approval code once the trusted device challenges', async () => {
    const relay = renderStep()
    expect(screen.getByText('Waiting for your other device…')).toBeInTheDocument()
    await settleUntil(() => relay.sessionId !== '')
    relay.challenged = true
    await act(async () => {
      await getClock().tickAsync(1500)
    })
    await settleUntil(() => relay.reveal !== '')
    await settleUntil(() => screen.queryByLabelText('Approval code') !== null)
    const code = await deriveApprovalCode(
      await getApprovalCodeContext(relay.sessionId),
      'trusted-1',
      challenge,
      relay.reveal,
    )
    expect(screen.getByLabelText('Approval code')).toHaveTextContent(code)
    expect(screen.queryByLabelText('Device fingerprint')).toBeNull()
  })

  it('falls back to the fingerprint when the backend has no approval code', async () => {
    renderStep({ available: false })
    await settleUntil(() => screen.queryByLabelText('Device fingerprint') !== null)
    expect(screen.getByLabelText('Device fingerprint')).toBeVisible()
    expect(screen.queryByText('Waiting for your other device…')).toBeNull()
  })

  it('offers a new code when starting one fails, instead of dropping to the fingerprint', async () => {
    const relay = renderStep({ failStart: true })
    await settleUntil(() => screen.queryByText("Couldn't get a code.") !== null)
    expect(screen.queryByLabelText('Device fingerprint')).toBeNull()

    relay.failStart = false
    fireEvent.click(screen.getByRole('button', { name: 'New code' }))
    await settleUntil(() => relay.sessionId !== '')
    expect(screen.getByText('Waiting for your other device…')).toBeInTheDocument()
  })

  it('offers passkey unlock when the account has a passkey slot', () => {
    const onUnlock = mock(() => {})
    renderStep({ onUnlockWithPasskey: onUnlock })

    fireEvent.click(screen.getByRole('button', { name: 'Unlock with passkey' }))

    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('hides passkey unlock when there is no slot', () => {
    renderStep()
    expect(screen.queryByRole('button', { name: 'Unlock with passkey' })).toBeNull()
  })

  it('swaps the code for the fingerprint and back', () => {
    renderStep()
    fireEvent.click(screen.getByRole('button', { name: 'Use fingerprint instead' }))
    expect(screen.getByLabelText('Device fingerprint')).toHaveTextContent(
      'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680-CD9B-98EE-0A09-C5B4-A48D-212E-295B-CA2C',
    )
    expect(screen.getByRole('button', { name: 'Copy fingerprint' })).toBeEnabled()
    expect(screen.queryByText('Waiting for your other device…')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Use code instead' }))
    expect(screen.queryByLabelText('Device fingerprint')).toBeNull()
    expect(screen.getByText('Waiting for your other device…')).toBeInTheDocument()
  })

  it('offers a manual check only after a check failed', () => {
    renderStep()
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
    cleanup()

    const onContinue = mock(() => {})
    renderStep({ error: 'This device has not been approved yet.', onContinue })
    expect(screen.getByRole('alert')).toHaveTextContent('This device has not been approved yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('keeps the fingerprint readable when clipboard access is refused', async () => {
    const copy = spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard denied'))
    try {
      renderStep()
      fireEvent.click(screen.getByRole('button', { name: 'Use fingerprint instead' }))
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy fingerprint' })))
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't copy. Select the fingerprint to copy it manually.")
      expect(screen.getByLabelText('Device fingerprint')).toBeVisible()
    } finally {
      copy.mockRestore()
    }
  })
})
