/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { ApprovalWaitingStep } from './approval-waiting-step'

describe('ApprovalWaitingStep', () => {
  afterEach(() => cleanup())

  const renderStep = (onUnlockWithPasskey?: () => void) =>
    render(
      <ApprovalWaitingStep
        fingerprint="FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680-CD9B-98EE-0A09-C5B4-A48D-212E-295B-CA2C"
        error={null}
        onContinue={() => {}}
        onUseRecoveryKey={() => {}}
        onUnlockWithPasskey={onUnlockWithPasskey}
      />,
    )

  it('offers passkey unlock when the account has a passkey slot', () => {
    const onUnlock = mock(() => {})
    renderStep(onUnlock)

    fireEvent.click(screen.getByRole('button', { name: 'Unlock with passkey' }))

    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('hides passkey unlock when there is no slot', () => {
    renderStep()
    expect(screen.queryByRole('button', { name: 'Unlock with passkey' })).toBeNull()
  })

  it('displays the local fingerprint for out-of-band confirmation', () => {
    renderStep()
    expect(screen.getByLabelText('Device fingerprint')).toHaveTextContent(
      'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680-CD9B-98EE-0A09-C5B4-A48D-212E-295B-CA2C',
    )
    expect(screen.getByRole('button', { name: 'Copy fingerprint' })).toBeEnabled()
  })

  it('keeps the fingerprint readable when clipboard access is refused', async () => {
    const copy = spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard denied'))
    try {
      renderStep()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy fingerprint' })))
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't copy. Select the fingerprint to copy it manually.")
      expect(screen.getByLabelText('Device fingerprint')).toBeVisible()
    } finally {
      copy.mockRestore()
    }
  })
})
