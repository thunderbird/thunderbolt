/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import {
  getActiveCloudUrl,
  getActiveServerEntry,
  getActiveServerId,
  getActiveTrustDomain,
  getActiveUserId,
  getRegistry,
  useTrustDomainRegistry,
} from './trust-domain-registry'

const storageKey = 'thunderbolt-trust-domains-v1'
const serverA = '11111111-1111-1111-1111-111111111111'
const serverB = '22222222-2222-2222-2222-222222222222'

const resetStore = () => {
  useTrustDomainRegistry.setState({
    servers: {},
    localUserId: 'local-user-fixture',
    activeTrustDomain: undefined,
  })
  localStorage.removeItem(storageKey)
}

describe('trust-domain registry store', () => {
  beforeEach(resetStore)
  afterEach(resetStore)

  it('starts with an empty servers map and undefined activeTrustDomain', () => {
    expect(getRegistry().servers).toEqual({})
    expect(getActiveTrustDomain()).toBeUndefined()
  })

  describe('activateServer', () => {
    it('upserts the entry and sets it as the active trust domain', () => {
      useTrustDomainRegistry.getState().activateServer({ serverId: serverA, cloudUrl: 'http://a.local' })

      expect(getRegistry().servers[serverA]).toEqual({ serverId: serverA, cloudUrl: 'http://a.local' })
      expect(getActiveTrustDomain()).toEqual({ kind: 'server', serverId: serverA })
    })

    it('merges into an existing entry without clobbering other fields', () => {
      const { activateServer } = useTrustDomainRegistry.getState()
      activateServer({ serverId: serverA, cloudUrl: 'http://a.local', userId: 'user-1' })
      activateServer({ serverId: serverA, cloudUrl: 'http://a-new.local' })

      expect(getRegistry().servers[serverA]).toEqual({
        serverId: serverA,
        cloudUrl: 'http://a-new.local',
        userId: 'user-1',
      })
    })

    it('switching active server keeps the previous entry but updates activeTrustDomain', () => {
      const { activateServer } = useTrustDomainRegistry.getState()
      activateServer({ serverId: serverA, cloudUrl: 'http://a.local' })
      activateServer({ serverId: serverB, cloudUrl: 'http://b.local' })

      expect(getActiveServerId()).toBe(serverB)
      expect(getActiveServerEntry()).toEqual({ serverId: serverB, cloudUrl: 'http://b.local' })
      // The first server is still in the registry — switching doesn't evict it.
      expect(getRegistry().servers[serverA]).toEqual({ serverId: serverA, cloudUrl: 'http://a.local' })
    })
  })

  describe('activateStandalone', () => {
    it('sets the active trust domain to standalone', () => {
      useTrustDomainRegistry.getState().activateStandalone()
      expect(getActiveTrustDomain()).toEqual({ kind: 'standalone' })
      expect(getActiveServerEntry()).toBeUndefined()
    })
  })

  describe('patchActiveServer', () => {
    it('updates only the active server entry', () => {
      const state = useTrustDomainRegistry.getState()
      state.activateServer({ serverId: serverB, cloudUrl: 'http://b.local' })
      state.activateServer({ serverId: serverA, cloudUrl: 'http://a.local' })

      useTrustDomainRegistry.getState().patchActiveServer({ userId: 'user-A', isAnonymous: false })

      expect(getRegistry().servers[serverA]).toMatchObject({ userId: 'user-A', isAnonymous: false })
      expect(getRegistry().servers[serverB]).toEqual({ serverId: serverB, cloudUrl: 'http://b.local' })
    })

    it('warns and no-ops when the active domain is standalone', () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        useTrustDomainRegistry.getState().activateStandalone()
        useTrustDomainRegistry.getState().patchActiveServer({ userId: 'whatever' })
        expect(getRegistry().servers).toEqual({})
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })

    it('warns and no-ops when no active domain is set', () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        useTrustDomainRegistry.getState().patchActiveServer({ userId: 'whatever' })
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('getters', () => {
    it('getActiveServerEntry returns the active server entry, undefined otherwise', () => {
      expect(getActiveServerEntry()).toBeUndefined()

      useTrustDomainRegistry.getState().activateServer({ serverId: serverA, cloudUrl: 'http://a.local' })
      expect(getActiveServerEntry()).toEqual({ serverId: serverA, cloudUrl: 'http://a.local' })

      useTrustDomainRegistry.getState().activateStandalone()
      expect(getActiveServerEntry()).toBeUndefined()
    })

    it('getActiveServerId is the active server id, undefined in standalone', () => {
      expect(getActiveServerId()).toBeUndefined()

      useTrustDomainRegistry.getState().activateServer({ serverId: serverA, cloudUrl: 'http://a.local' })
      expect(getActiveServerId()).toBe(serverA)

      useTrustDomainRegistry.getState().activateStandalone()
      expect(getActiveServerId()).toBeUndefined()
    })

    it('getActiveCloudUrl reflects the active server entry', () => {
      expect(getActiveCloudUrl()).toBeUndefined()

      useTrustDomainRegistry.getState().activateServer({ serverId: serverA, cloudUrl: 'http://a.local' })
      expect(getActiveCloudUrl()).toBe('http://a.local')

      useTrustDomainRegistry.getState().patchActiveServer({ cloudUrl: 'http://a-new.local' })
      expect(getActiveCloudUrl()).toBe('http://a-new.local')

      useTrustDomainRegistry.getState().activateStandalone()
      expect(getActiveCloudUrl()).toBeUndefined()
    })

    it('getActiveUserId returns localUserId in standalone, the active server entry userId in server mode', () => {
      useTrustDomainRegistry.setState({
        localUserId: 'local-user-xyz',
        activeTrustDomain: { kind: 'standalone' },
      })
      expect(getActiveUserId()).toBe('local-user-xyz')

      useTrustDomainRegistry.setState({
        servers: { [serverA]: { serverId: serverA, cloudUrl: 'http://a.local', userId: 'session-user-1' } },
        activeTrustDomain: { kind: 'server', serverId: serverA },
      })
      expect(getActiveUserId()).toBe('session-user-1')
    })

    it('getActiveUserId is undefined in server mode before a session has been observed', () => {
      useTrustDomainRegistry.getState().activateServer({ serverId: serverA, cloudUrl: 'http://a.local' })
      expect(getActiveUserId()).toBeUndefined()
    })
  })

  it('localUserId is a UUIDv7', () => {
    resetStore() // restores the fixture localUserId

    const fresh = uuidv7()
    useTrustDomainRegistry.setState({ localUserId: fresh })
    expect(useTrustDomainRegistry.getState().localUserId).toBe(fresh)
    expect(fresh).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
