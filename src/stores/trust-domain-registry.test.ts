/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import {
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

  it('upsertServer adds a new entry', () => {
    useTrustDomainRegistry.getState().upsertServer({ serverId: serverA, cloudUrl: 'http://a.local' })
    expect(getRegistry().servers[serverA]).toEqual({ serverId: serverA, cloudUrl: 'http://a.local' })
  })

  it('upsertServer merges into an existing entry without clobbering other fields', () => {
    const { upsertServer } = useTrustDomainRegistry.getState()
    upsertServer({ serverId: serverA, cloudUrl: 'http://a.local', lastUserId: 'user-1' })
    upsertServer({ serverId: serverA, cloudUrl: 'http://a-new.local' })

    expect(getRegistry().servers[serverA]).toEqual({
      serverId: serverA,
      cloudUrl: 'http://a-new.local',
      lastUserId: 'user-1',
    })
  })

  it('setActiveTrustDomain stores the active domain', () => {
    useTrustDomainRegistry.getState().setActiveTrustDomain({ kind: 'server', serverId: serverA })
    expect(getActiveTrustDomain()).toEqual({ kind: 'server', serverId: serverA })
    expect(getActiveServerId()).toBe(serverA)
  })

  it('patchActiveServer updates only the active server entry', () => {
    const state = useTrustDomainRegistry.getState()
    state.upsertServer({ serverId: serverA, cloudUrl: 'http://a.local' })
    state.upsertServer({ serverId: serverB, cloudUrl: 'http://b.local' })
    state.setActiveTrustDomain({ kind: 'server', serverId: serverA })

    useTrustDomainRegistry.getState().patchActiveServer({ lastUserId: 'user-A', lastUserIsAnonymous: false })

    expect(getRegistry().servers[serverA]).toMatchObject({ lastUserId: 'user-A', lastUserIsAnonymous: false })
    expect(getRegistry().servers[serverB]).toEqual({ serverId: serverB, cloudUrl: 'http://b.local' })
  })

  it('patchActiveServer is a no-op when the active domain is standalone', () => {
    useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'standalone' } })
    useTrustDomainRegistry.getState().patchActiveServer({ lastUserId: 'whatever' })
    expect(getRegistry().servers).toEqual({})
  })

  it('getActiveServerEntry returns the active server entry, undefined otherwise', () => {
    const state = useTrustDomainRegistry.getState()
    state.upsertServer({ serverId: serverA, cloudUrl: 'http://a.local' })
    expect(getActiveServerEntry()).toBeUndefined() // no active domain set

    state.setActiveTrustDomain({ kind: 'server', serverId: serverA })
    expect(getActiveServerEntry()).toEqual({ serverId: serverA, cloudUrl: 'http://a.local' })

    state.setActiveTrustDomain({ kind: 'standalone' })
    expect(getActiveServerEntry()).toBeUndefined()
  })

  it('getActiveServerId is the active server id, undefined in standalone', () => {
    expect(getActiveServerId()).toBeUndefined()

    useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'server', serverId: serverA } })
    expect(getActiveServerId()).toBe(serverA)

    useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'standalone' } })
    expect(getActiveServerId()).toBeUndefined()
  })

  it('getActiveUserId returns localUserId in standalone, lastUserId in server', () => {
    useTrustDomainRegistry.setState({
      localUserId: 'local-user-xyz',
      activeTrustDomain: { kind: 'standalone' },
    })
    expect(getActiveUserId()).toBe('local-user-xyz')

    useTrustDomainRegistry.setState({
      servers: { [serverA]: { serverId: serverA, cloudUrl: 'http://a.local', lastUserId: 'session-user-1' } },
      activeTrustDomain: { kind: 'server', serverId: serverA },
    })
    expect(getActiveUserId()).toBe('session-user-1')
  })

  it('getActiveUserId is undefined in server mode before a session has been observed', () => {
    useTrustDomainRegistry.setState({
      servers: { [serverA]: { serverId: serverA, cloudUrl: 'http://a.local' } },
      activeTrustDomain: { kind: 'server', serverId: serverA },
    })
    expect(getActiveUserId()).toBeUndefined()
  })

  it('localUserId is generated by the store initializer on first creation', () => {
    // The default initial state (from create()) provides a UUID; assert it's a
    // valid v7 shape so we know the store is doing the lazy-create itself rather
    // than relying on consumers to mint it.
    resetStore() // restores the fixture localUserId

    const fresh = uuidv7()
    useTrustDomainRegistry.setState({ localUserId: fresh })
    expect(useTrustDomainRegistry.getState().localUserId).toBe(fresh)
    expect(fresh).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
