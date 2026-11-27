/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { EmailCodeSignIn } from './email-code-sign-in'

describe('EmailCodeSignIn', () => {
  afterEach(() => {
    cleanup()
  })

  it('gives the SSO email-code page with a copy button', () => {
    render(<EmailCodeSignIn origin="https://app.example.com" ssoMode />)

    expect(screen.getByLabelText('Email-code sign-in address')).toHaveValue(
      'https://app.example.com/sign-in/email-code',
    )
    expect(screen.getByRole('button', { name: 'Copy the sign-in address' })).toBeInTheDocument()
  })

  it('gives the sign-in page itself outside SSO mode, where it asks for the code', () => {
    render(<EmailCodeSignIn origin="https://app.example.com" ssoMode={false} />)

    expect(screen.getByLabelText('Email-code sign-in address')).toHaveValue('https://app.example.com/')
    expect(screen.queryByText(/Keep this address/)).toBeNull()
  })

  it('shows only the path without a web origin', () => {
    render(<EmailCodeSignIn origin={null} ssoMode />)

    expect(screen.getByText('/sign-in/email-code')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy the sign-in address' })).not.toBeInTheDocument()
  })
})
