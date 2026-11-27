/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AdminConnectionDetail } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createAdminTestHarness, flush } from '../../test-utils'
import { SsoSettingsForm, SsoSettingsSection } from './sso-settings-section'
import type { SsoConnectionDetail } from './use-sso-settings-state'

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

const renderForm = (detail: SsoConnectionDetail) => {
  const harness = createAdminTestHarness(() => ({ body: detail }))
  const onSaved = mock()
  render(<SsoSettingsForm detail={detail} onDirty={() => {}} onCancel={() => {}} onSaved={onSaved} />, {
    wrapper: harness.wrapper,
  })
  return { harness, onSaved }
}

const oidcSso = oidcDetail as SsoConnectionDetail

describe('SsoSettingsSection', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('shows the settings as text in the view, with only the setup URLs to copy', () => {
    renderSection(oidcDetail)
    expect(screen.getByText('https://idp.test')).toBeInTheDocument()
    expect(screen.getByText('client')).toBeInTheDocument()
    expect(screen.getAllByRole('textbox').map((field) => field.getAttribute('aria-label'))).toEqual(['Redirect URI'])
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('prefills the edit form with only the fields that can change', () => {
    renderForm(oidcSso)
    expect(screen.getByLabelText('Client ID')).toHaveValue('client')
    expect(screen.getByLabelText('Client ID')).toBeEnabled()
    expect(screen.getByLabelText('New client secret')).toHaveValue('')
    expect(screen.queryByText('https://idp.test')).toBeNull()
    expect(screen.queryByLabelText('Issuer')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('shows each locked field read-only with why, before any edit', () => {
    renderForm({ ...oidcSso, lockedFields: ['clientId', 'discoveryEndpoint', 'matchClaim'] })
    expect(screen.getByLabelText('Client ID')).toBeDisabled()
    expect(screen.getByLabelText('Client ID')).toHaveAccessibleDescription('Locked after the first sign-in.')
    expect(screen.getByLabelText('Match claim')).toHaveAccessibleDescription(/link review/)
    expect(screen.getByLabelText('New client secret')).toBeEnabled()
  })

  it('sends only the replaced secret, then hands back to the view', async () => {
    const { harness, onSaved } = renderForm(oidcSso)
    fireEvent.change(screen.getByLabelText('New client secret'), { target: { value: 'rotated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(harness.requests.find((request) => request.path.startsWith('admin/'))).toMatchObject({
      method: 'PATCH',
      path: 'admin/connections/c1',
      body: { oidc: { clientSecret: 'rotated' } },
    })
  })

  it('shows the env connection read-only', () => {
    renderSection({ ...oidcDetail, sso: { ...oidcDetail.sso!, envOwned: true } })
    expect(screen.getByText('client')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('offers SSO on a SCIM-only connection, keeping its name and offering no rename', async () => {
    const harness = renderSection(scimOnly)
    expect(screen.queryByLabelText('Name')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add OIDC sign-in' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.getByText(/can no longer sign in with an email code/)).toBeInTheDocument()
    for (const [label, value] of [
      ['Provider ID', 'acme'],
      ['Issuer', 'https://idp.test'],
      ['Client ID', 'client'],
      ['Client secret', 'secret'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await flush()
    expect(harness.requests.find((request) => request.path.startsWith('admin/'))).toMatchObject({
      method: 'POST',
      path: 'admin/connections/sso',
      body: { name: 'Acme SCIM', identityConnectionId: 'c1', providerId: 'acme' },
    })
  })
})
