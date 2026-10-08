/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { StepUpCodeDialog } from '@/components/step-up-code-dialog'
import { stepUpOtpLength } from '@/lib/constants'

const noop = () => {}

const renderDialog = (props: Partial<Parameters<typeof StepUpCodeDialog>[0]> = {}) =>
  render(
    <StepUpCodeDialog
      open
      otp=""
      isBusy={false}
      error={null}
      description="Enter it to delete your account."
      submitLabel="Delete account"
      submitLoadingLabel="Deleting…"
      onOtpChange={noop}
      onResend={noop}
      onSubmit={noop}
      onCancel={noop}
      {...props}
    />,
  )

describe('StepUpCodeDialog', () => {
  afterEach(cleanup)

  it('renders the copy the caller passed, not a recovery-phrase default', () => {
    renderDialog()

    expect(screen.getByText('Enter it to delete your account.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeInTheDocument()
    expect(screen.queryByText(/recovery phrase/i)).toBeNull()
  })

  it('keeps submit disabled until the code is complete', () => {
    renderDialog({ otp: '1234' })
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeDisabled()

    cleanup()
    renderDialog({ otp: '1'.repeat(stepUpOtpLength) })
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeEnabled()
  })

  it('surfaces an error to assistive tech', () => {
    renderDialog({ error: 'That code is invalid or expired.' })
    expect(screen.getByRole('alert')).toHaveTextContent('That code is invalid or expired.')
  })

  // NOT covered here: that the delete flow does not auto-submit on the last
  // digit (`submitOnComplete`). It needs the real `InputOTP`, and
  // `sign-in-modal.test.tsx` replaces that module process-wide via
  // `mock.module` (it runs fake timers, which the library's internal timers
  // fight), so such a test passes or fails on file ordering.
})
