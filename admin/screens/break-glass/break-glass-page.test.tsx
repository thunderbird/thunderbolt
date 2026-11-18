/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { BreakGlassStatus } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply } from '../../test-utils'
import { BreakGlassPage } from './break-glass-page'

const renderPage = async (reply: FakeReply) => {
  const harness = createAdminTestHarness(() => reply)
  render(<BreakGlassPage />, { wrapper: harness.wrapper })
  await flush()
}

const status = (overrides: Partial<BreakGlassStatus>): BreakGlassStatus => ({
  allAdminsIdpManaged: false,
  adminCount: 3,
  localAdminCount: 1,
  ...overrides,
})

describe('BreakGlassPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('counts the admins who can sign in without the identity provider', async () => {
    await renderPage({ body: status({}) })

    expect(screen.getByText('1 admin can sign in without your identity provider')).toBeInTheDocument()
    expect(screen.getByText(/This organization has 3 admins\./)).toBeInTheDocument()
  })

  it('warns when every admin depends on the identity provider, and points to Members', async () => {
    await renderPage({ body: status({ allAdminsIdpManaged: true, localAdminCount: 0 }) })

    expect(screen.getByText('No admin can sign in without your identity provider')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/admin/members')
  })

  it('shows the error when the status is unavailable', async () => {
    await renderPage({ status: 403, body: { code: 'ADMIN_REQUIRED' } })

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/can sign in without your identity provider/)).not.toBeInTheDocument()
  })

  it('gives the email-code sign-in address with a copy button (the test config is not SSO)', async () => {
    await renderPage({ body: status({}) })

    expect(screen.getByLabelText('Email-code sign-in address')).toHaveValue(`${window.location.origin}/`)
    expect(screen.getByRole('button', { name: 'Copy the sign-in address' })).toBeInTheDocument()
  })
})
