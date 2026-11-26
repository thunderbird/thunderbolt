/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { SignInOtpStep } from './sign-in-otp-step'

describe('OTP resend controls', () => {
  it.each(['modal', 'page'] as const)(
    'disables code entry and verification during resend in the %s layout',
    (variant) => {
      const props = {
        email: 'test@example.com',
        otp: '12345678',
        errorMessage: '',
        isLocalhost: false,
        variant,
        onOtpChange: mock(),
        onOtpComplete: mock(),
        onResend: async () => false,
        onCancel: mock(),
      }
      const { rerender } = render(<SignInOtpStep {...props} status="resending" />)
      expect(screen.getByRole('textbox')).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Resend Email' })).toBeDisabled()
      if (variant === 'page') {
        expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
      } else {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
      }
      rerender(<SignInOtpStep {...props} status="sent" otp="" errorMessage="Try again later" />)
      expect(screen.getByRole('textbox')).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Resend Email' })).toBeEnabled()
      expect(screen.getByText('Try again later')).toBeInTheDocument()
    },
  )
})
