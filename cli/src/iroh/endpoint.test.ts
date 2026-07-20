/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transport-configuration tests for the iroh endpoint. The relay-override seam is
 * exercised with a fake builder + fake configurator, so neither a native iroh
 * endpoint nor a relay is bound — only the decision (n0 default vs custom relay)
 * is asserted.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { EndpointBuilder, RelayMode } from '@number0/iroh'
import { EndpointAddr, EndpointId, EndpointTicket, SecretKey } from '@number0/iroh'
import { configureTransport, relayUrlOverride, resolveTarget } from './endpoint.ts'

const relayEnv = 'THUNDERBOLT_IROH_RELAY_URL'

afterEach(() => {
  delete process.env[relayEnv]
})

describe('relayUrlOverride', () => {
  it('is undefined when the env var is unset', () => {
    expect(relayUrlOverride({})).toBeUndefined()
  })

  it('is undefined when the env var is empty or whitespace', () => {
    expect(relayUrlOverride({ [relayEnv]: '' })).toBeUndefined()
    expect(relayUrlOverride({ [relayEnv]: '   ' })).toBeUndefined()
  })

  it('returns the trimmed url when the env var is set', () => {
    expect(relayUrlOverride({ [relayEnv]: '  wss://relay.example  ' })).toBe('wss://relay.example')
  })
})

type FakeBuilder = EndpointBuilder & { relayMode: ReturnType<typeof mock> }

const makeConfigurator = () => {
  const relayMode = { custom: true } as unknown as RelayMode
  return {
    applyPreset: mock<(builder: EndpointBuilder) => void>(() => {}),
    customRelayMode: mock<(urls: string[]) => RelayMode>(() => relayMode),
    relayMode,
  }
}

const makeBuilder = (): FakeBuilder => ({ relayMode: mock(() => {}) }) as unknown as FakeBuilder

describe('configureTransport', () => {
  it('applies the n0 preset and leaves the relay untouched when the env var is unset', () => {
    const builder = makeBuilder()
    const cfg = makeConfigurator()
    configureTransport(builder, cfg)
    expect(cfg.applyPreset).toHaveBeenCalledTimes(1)
    expect(cfg.customRelayMode).not.toHaveBeenCalled()
    expect(builder.relayMode).not.toHaveBeenCalled()
  })

  it('threads the custom relay url through to the builder when the env var is set', () => {
    process.env[relayEnv] = 'wss://relay.example'
    const builder = makeBuilder()
    const cfg = makeConfigurator()
    configureTransport(builder, cfg)
    expect(cfg.applyPreset).toHaveBeenCalledTimes(1)
    expect(cfg.customRelayMode).toHaveBeenCalledWith(['wss://relay.example'])
    expect(builder.relayMode).toHaveBeenCalledWith(cfg.relayMode)
  })
})

describe('resolveTarget — ticket vs bare NodeId', () => {
  const nodeId = SecretKey.generate().public().toString()
  const relayUrl = 'https://relay.example./'
  const ticket = EndpointTicket.fromAddr(new EndpointAddr(EndpointId.fromString(nodeId), relayUrl, [])).toString()

  it('resolves a bare NodeId to an addr for that node with no relay (relies on n0 discovery)', () => {
    const addr = resolveTarget(nodeId)
    expect(addr.id().toString()).toBe(nodeId)
    expect(addr.relayUrl()).toBeNull()
    expect(addr.directAddresses()).toEqual([])
  })

  it('resolves a full ticket via the ticket branch, carrying its relay URL through', () => {
    // Proves the ticket path was taken: the bare-NodeId fallback would throw on a
    // ticket, and a bare NodeId would have a null relay — this addr carries one.
    expect(() => EndpointId.fromString(ticket)).toThrow()
    const addr = resolveTarget(ticket)
    expect(addr.id().toString()).toBe(nodeId)
    expect(addr.relayUrl()).toBe(relayUrl)
  })

  it('throws on a target that is neither a ticket nor a NodeId', () => {
    expect(() => resolveTarget('not-a-real-target')).toThrow()
  })
})
