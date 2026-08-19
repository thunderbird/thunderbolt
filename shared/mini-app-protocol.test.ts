/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  isSupportedProtocolVersion,
  miniAppProtocolMarker,
  miniAppProtocolVersion,
  parseGuestMessage,
  parseGuestResult,
  selectionQueryResultSchema,
} from './mini-app-protocol'

const initialize = {
  jsonrpc: '2.0',
  protocol: miniAppProtocolMarker,
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, appName: 'Finance Model', capabilities: {} },
}

const contextUpdate = {
  jsonrpc: '2.0',
  protocol: miniAppProtocolMarker,
  method: 'context/update',
  params: { context: { title: 'Q3', summary: 'Revenue model for Q3.' } },
}

describe('parseGuestMessage', () => {
  it('accepts a well-formed initialize request', () => {
    const parsed = parseGuestMessage(initialize)
    expect(parsed?.method).toBe('initialize')
  })

  it('accepts a context/update notification without an id', () => {
    const parsed = parseGuestMessage(contextUpdate)
    expect(parsed?.method).toBe('context/update')
  })

  it('accepts chat/open with no params, defaulting them', () => {
    const parsed = parseGuestMessage({
      jsonrpc: '2.0',
      protocol: miniAppProtocolMarker,
      id: 'a',
      method: 'chat/open',
    })
    expect(parsed?.method).toBe('chat/open')
  })

  it('carries optional data and selection through untouched', () => {
    const selection = { row: 3 }
    const data = { quarters: [1, 2, 3] }
    const parsed = parseGuestMessage({
      ...contextUpdate,
      params: { context: { title: 'Q3', summary: 's', data, selection } },
    })
    expect(parsed).not.toBeNull()
    if (parsed?.method !== 'context/update') {
      throw new Error('expected a context/update')
    }
    expect(parsed.params.context.selection).toEqual(selection)
    expect(parsed.params.context.data).toEqual(data)
  })

  // The bus carries React DevTools, Vite HMR and extension traffic — anything
  // unmarked must be ignored rather than parsed.
  it.each([
    ['a non-object', 'hello'],
    ['null', null],
    ['a message with no protocol marker', { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }],
    ['a foreign protocol marker', { ...initialize, protocol: 'some-other-bridge' }],
  ])('rejects %s', (_label, payload) => {
    expect(parseGuestMessage(payload)).toBeNull()
  })

  it('rejects an unknown method even when correctly marked', () => {
    expect(parseGuestMessage({ ...initialize, method: 'app/deleteEverything' })).toBeNull()
  })

  it('rejects a context/update whose context is missing required fields', () => {
    expect(parseGuestMessage({ ...contextUpdate, params: { context: { title: 'Q3' } } })).toBeNull()
  })

  it('rejects a non-2.0 jsonrpc envelope', () => {
    expect(parseGuestMessage({ ...initialize, jsonrpc: '1.0' })).toBeNull()
  })

  it('rejects an initialize request with no id (a request must be answerable)', () => {
    const { id: _id, ...withoutId } = initialize
    expect(parseGuestMessage(withoutId)).toBeNull()
  })
})

describe('selection/changed', () => {
  const selectionMessage = (selection: unknown) => ({
    jsonrpc: '2.0',
    protocol: miniAppProtocolMarker,
    method: 'selection/changed',
    params: { selection },
  })

  it('accepts a selection with geometry', () => {
    const parsed = parseGuestMessage(
      selectionMessage({ text: 'gross profit', rect: { x: 1, y: 2, width: 3, height: 4 } }),
    )
    expect(parsed?.method).toBe('selection/changed')
  })

  it('accepts a selection without geometry, for apps that cannot report it', () => {
    expect(parseGuestMessage(selectionMessage({ text: 'gross profit' }))).not.toBeNull()
  })

  // Null is how the guest says "the user deselected" — it must parse, not be
  // dropped, or the host's floating control would never dismiss.
  it('accepts an explicit null selection', () => {
    const parsed = parseGuestMessage(selectionMessage(null))
    expect(parsed).not.toBeNull()
    if (parsed?.method !== 'selection/changed') {
      throw new Error('expected a selection/changed')
    }
    expect(parsed.params.selection).toBeNull()
  })

  it('rejects an empty-string selection (deselect must be sent as null)', () => {
    expect(parseGuestMessage(selectionMessage({ text: '' }))).toBeNull()
  })

  it('rejects a rect with non-numeric coordinates', () => {
    expect(parseGuestMessage(selectionMessage({ text: 'x', rect: { x: '1', y: 2, width: 3, height: 4 } }))).toBeNull()
  })

  it('rejects a selection longer than the cap', () => {
    expect(parseGuestMessage(selectionMessage({ text: 'a'.repeat(20_001) }))).toBeNull()
  })
})

describe('isSupportedProtocolVersion', () => {
  it('accepts the current version', () => {
    expect(isSupportedProtocolVersion(miniAppProtocolVersion)).toBe(true)
  })

  it('rejects other versions in both directions', () => {
    expect(isSupportedProtocolVersion(miniAppProtocolVersion + 1)).toBe(false)
    expect(isSupportedProtocolVersion(0)).toBe(false)
  })
})

describe('parseGuestResult', () => {
  const reply = { jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: 7, result: { items: [] } }

  it('reads a reply and its id', () => {
    expect(parseGuestResult(reply)).toEqual({ id: 7, result: { items: [] } })
  })

  it('ignores a reply without the protocol marker', () => {
    expect(parseGuestResult({ jsonrpc: '2.0', id: 7, result: {} })).toBeNull()
  })

  // A notification has no id, so it can't be routed to a pending request.
  it('ignores a message with no id', () => {
    expect(parseGuestResult({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, result: {} })).toBeNull()
  })
})

describe('selectionQueryResultSchema', () => {
  const item = { id: 'a', label: 'Q3 row', text: 'Revenue: 4.2M' }

  it('accepts a well-formed item list', () => {
    expect(selectionQueryResultSchema.safeParse({ items: [item] }).success).toBe(true)
  })

  it('accepts an empty list — the marquee covered nothing selectable', () => {
    expect(selectionQueryResultSchema.safeParse({ items: [] }).success).toBe(true)
  })

  it('rejects an item with empty text', () => {
    expect(selectionQueryResultSchema.safeParse({ items: [{ ...item, text: '' }] }).success).toBe(false)
  })

  // A drag across the whole page shouldn't be able to push hundreds of chips
  // into the composer.
  it('rejects more items than the cap', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...item, id: String(i) }))
    expect(selectionQueryResultSchema.safeParse({ items: many }).success).toBe(false)
  })
})
