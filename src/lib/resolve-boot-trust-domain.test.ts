/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { resolveBootTrustDomain, type BootEnv } from './resolve-boot-trust-domain'

const serverId = 'aaaaaaaa-1111-2222-3333-444444444444'

const baseEnv: BootEnv = { standaloneModeEnabled: false, defaultServerUrl: '' }

const resetRegistry = () => {
  useTrustDomainRegistry.setState({
    servers: {},
    activeTrustDomain: undefined,
  })
}

describe('resolveBootTrustDomain', () => {
  beforeEach(resetRegistry)
  afterEach(resetRegistry)

  describe('returning device (registry has activeTrustDomain)', () => {
    it('returns standalone when the registry pinned it', async () => {
      useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'standalone' } })
      const fetchConfig = mock(async () => null)

      const result = await resolveBootTrustDomain({ env: baseEnv, fetchConfig })

      expect(result).toEqual({ kind: 'resolved', trustDomain: { kind: 'standalone' } })
      expect(fetchConfig).not.toHaveBeenCalled()
    })

    it('returns the cached server entry without fetching /v1/config', async () => {
      useTrustDomainRegistry.setState({
        servers: { [serverId]: { serverId, cloudUrl: 'http://cached.local' } },
        activeTrustDomain: { kind: 'server', serverId },
      })
      const fetchConfig = mock(async () => null)

      const result = await resolveBootTrustDomain({ env: baseEnv, fetchConfig })

      expect(result).toEqual({
        kind: 'resolved',
        trustDomain: { kind: 'server', serverId },
        serverEntry: { serverId, cloudUrl: 'http://cached.local' },
      })
      expect(fetchConfig).not.toHaveBeenCalled()
    })

    it('falls through to env resolution when activeTrustDomain references a missing server entry', async () => {
      useTrustDomainRegistry.setState({
        servers: {},
        activeTrustDomain: { kind: 'server', serverId },
      })
      const fetchConfig = mock(async () => null)

      const result = await resolveBootTrustDomain({
        env: { standaloneModeEnabled: true, defaultServerUrl: '' },
        fetchConfig,
      })

      expect(result).toEqual({ kind: 'resolved', trustDomain: { kind: 'standalone' } })
    })
  })

  describe('first boot (empty registry)', () => {
    it('picks standalone when the env enables it', async () => {
      const fetchConfig = mock(async () => null)

      const result = await resolveBootTrustDomain({
        env: { standaloneModeEnabled: true, defaultServerUrl: 'http://ignored.local' },
        fetchConfig,
      })

      expect(result).toEqual({ kind: 'resolved', trustDomain: { kind: 'standalone' } })
      expect(fetchConfig).not.toHaveBeenCalled()
    })

    it('fetches /v1/config and pins the returned serverId when only the default URL is set', async () => {
      const fetchConfig = mock(async () => ({ serverId, e2eeEnabled: false }))

      const result = await resolveBootTrustDomain({
        env: { standaloneModeEnabled: false, defaultServerUrl: 'http://default.local' },
        fetchConfig,
      })

      expect(result).toEqual({
        kind: 'resolved',
        trustDomain: { kind: 'server', serverId },
        serverEntry: { serverId, cloudUrl: 'http://default.local' },
      })
      expect(fetchConfig).toHaveBeenCalledWith('http://default.local')
    })

    it('reports fetch-failed when /v1/config returns null', async () => {
      const fetchConfig = mock(async () => null)

      const result = await resolveBootTrustDomain({
        env: { standaloneModeEnabled: false, defaultServerUrl: 'http://default.local' },
        fetchConfig,
      })

      expect(result).toEqual({ kind: 'fetch-failed', cloudUrl: 'http://default.local' })
    })

    it('reports fetch-failed when /v1/config returns without a serverId', async () => {
      const fetchConfig = mock(async () => ({ e2eeEnabled: true }))

      const result = await resolveBootTrustDomain({
        env: { standaloneModeEnabled: false, defaultServerUrl: 'http://default.local' },
        fetchConfig,
      })

      expect(result).toEqual({ kind: 'fetch-failed', cloudUrl: 'http://default.local' })
    })

    it('reports no-trust-domain when both standalone and default URL are off (mode-picker territory)', async () => {
      const fetchConfig = mock(async () => null)

      const result = await resolveBootTrustDomain({
        env: { standaloneModeEnabled: false, defaultServerUrl: '' },
        fetchConfig,
      })

      expect(result).toEqual({ kind: 'no-trust-domain' })
      expect(fetchConfig).not.toHaveBeenCalled()
    })

    it('prefers standalone over default URL when both env flags are set', async () => {
      const fetchConfig = mock(async () => ({ serverId, e2eeEnabled: false }))

      const result = await resolveBootTrustDomain({
        env: { standaloneModeEnabled: true, defaultServerUrl: 'http://default.local' },
        fetchConfig,
      })

      expect(result).toEqual({ kind: 'resolved', trustDomain: { kind: 'standalone' } })
      expect(fetchConfig).not.toHaveBeenCalled()
    })
  })
})
