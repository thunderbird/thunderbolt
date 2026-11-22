/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AdminConnectionDetail } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush } from '../../test-utils'
import { SsoSettingsSection } from './sso-settings-section'

const oidcDetail: AdminConnectionDetail = {
  id: 'c1',
  name: 'Acme',
  status: 'active',
  matchClaim: 'sub',
  sso: {
    providerId: 'acme',
    protocol: 'oidc',
    issuer: 'https://idp.test',
    envOwned: false,
    clientId: 'client',
    discoveryEndpoint: 'https://idp.test/.well-known/openid-configuration',
  },
  scim: null,
  claimedDomains: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  lockedFields: [],
  scimCredentials: [],
}

const scimOnly: AdminConnectionDetail = {
  ...oidcDetail,
  name: 'Acme SCIM',
  sso: null,
  scim: { scimConnectionId: 's1' },
}

const renderSection = (detail: AdminConnectionDetail) => {
  const harness = createAdminTestHarness(() => ({ body: detail }))
  render(<SsoSettingsSection detail={detail} onDirty={() => {}} />, { wrapper: harness.wrapper })
  return harness
}

describe('SsoSettingsSection', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('prefills the settings and shows the identity fields read-only', () => {
    renderSection(oidcDetail)
    expect(screen.getByLabelText('Client ID')).toHaveValue('client')
    expect(screen.getByLabelText('Client ID')).not.toHaveAttribute('readonly')
    expect(screen.getByLabelText('New client secret')).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Issuer' })).toHaveValue('https://idp.test')
    expect(screen.getByRole('textbox', { name: 'Issuer' })).toHaveAttribute('readonly')
    expect(screen.getByText(/can't change\. To use a different one/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('shows each locked field read-only with why, before any edit', () => {
    renderSection({ ...oidcDetail, lockedFields: ['clientId', 'discoveryEndpoint', 'matchClaim'] })
    expect(screen.getByLabelText('Client ID')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('Client ID')).toHaveAccessibleDescription(
      /Locked because people have signed in through this connection/,
    )
    expect(screen.getByLabelText('Match claim')).toHaveAccessibleDescription(/link reviews/)
    expect(screen.getByLabelText('New client secret')).not.toHaveAttribute('readonly')
  })

  it('sends only the replaced secret', async () => {
    const harness = renderSection(oidcDetail)
    fireEvent.change(screen.getByLabelText('New client secret'), { target: { value: 'rotated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await flush()
    expect(harness.requests.find((request) => request.path.startsWith('admin/'))).toMatchObject({
      method: 'PATCH',
      path: 'admin/connections/c1',
      body: { oidc: { clientSecret: 'rotated' } },
    })
  })

  it('shows the env connection read-only', () => {
    renderSection({ ...oidcDetail, sso: { ...oidcDetail.sso!, envOwned: true } })
    expect(screen.getByText("Set by this server's OIDC or SAML settings. Change them there.")).toBeInTheDocument()
    for (const field of screen.getAllByRole('textbox')) {
      expect(field).toHaveAttribute('readonly')
    }
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('offers SSO on a SCIM-only connection, keeping its name and offering no rename', async () => {
    const harness = renderSection(scimOnly)
    expect(screen.queryByLabelText('Name')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add OIDC sign-in' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.getByText(/Adding sign-in makes this connection SSO-only/)).toHaveTextContent(
      'can no longer sign in with an email code',
    )
    for (const [label, value] of [
      ['Provider ID', 'acme'],
      ['Issuer', 'https://idp.test'],
      ['Client ID', 'client'],
      ['Client secret', 'secret'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add single sign-on' }))
    await flush()
    expect(harness.requests.find((request) => request.path.startsWith('admin/'))).toMatchObject({
      method: 'POST',
      path: 'admin/connections/sso',
      body: { name: 'Acme SCIM', identityConnectionId: 'c1', providerId: 'acme' },
    })
  })
})
