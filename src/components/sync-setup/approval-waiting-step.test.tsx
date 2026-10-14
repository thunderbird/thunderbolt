/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ApprovalWaitingStep } from './approval-waiting-step'

describe('ApprovalWaitingStep', () => {
  afterEach(() => cleanup())

  const renderStep = (onUnlockWithPasskey?: () => void) =>
    render(
      <ApprovalWaitingStep
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
})
