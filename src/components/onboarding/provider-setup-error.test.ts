/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { i18n } from '@/i18n'
import { ProviderSetupError, providerSetupErrorMessage, runProviderSetupStage } from './provider-setup-error'

describe('provider setup failures', () => {
  it('distinguishes enclave verification from credentials without exposing the underlying error', () => {
    const cause = Object.assign(new Error('secret-response'), { name: 'TinfoilAttestationError' })
    const text = i18n._(providerSetupErrorMessage(new ProviderSetupError('catalog', cause)))
    expect(text).toContain('secure environment')
    expect(text).not.toContain('secret-response')
  })
  it('reports a numeric provider status without copying its response body', () => {
    const cause = Object.assign(new Error('secret-key'), { statusCode: 403 })
    const text = i18n._(providerSetupErrorMessage(new ProviderSetupError('probe', cause)))
    expect(text).toContain('HTTP 403')
    expect(text).not.toContain('secret-key')
  })
  it('distinguishes a failed device save from model access', async () => {
    try {
      await runProviderSetupStage('save', async () => {
        throw new Error('database detail')
      })
      throw new Error('Expected setup to fail')
    } catch (error) {
      expect(i18n._(providerSetupErrorMessage(error))).toContain('save the provider connection')
    }
  })
})
