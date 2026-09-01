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
  method: 'ui/initialize',
  params: { protocolVersion: 1, appName: 'Finance Model', capabilities: {} },
}

const contextUpdate = {
  jsonrpc: '2.0',
  protocol: miniAppProtocolMarker,
  method: 'ui/update-model-context',
  params: { context: { title: 'Q3', summary: 'Revenue model for Q3.' } },
}

describe('parseGuestMessage', () => {
  it('accepts ui/request-auth-token, defaulting its empty params', () => {
    const parsed = parseGuestMessage({
      jsonrpc: '2.0',
      protocol: 'thunderbolt-miniapp',
      id: 7,
      method: 'ui/request-auth-token',
    })
    expect(parsed?.method).toBe('ui/request-auth-token')
  })

  it('rejects a token request without an id, which would have nowhere to reply', () => {
    const parsed = parseGuestMessage({
      jsonrpc: '2.0',
      protocol: 'thunderbolt-miniapp',
      method: 'ui/request-auth-token',
    })
    expect(parsed).toBeNull()
  })

  it('accepts a well-formed initialize request', () => {
    const parsed = parseGuestMessage(initialize)
    expect(parsed?.method).toBe('ui/initialize')
  })

  it('accepts a ui/update-model-context notification without an id', () => {
    const parsed = parseGuestMessage(contextUpdate)
    expect(parsed?.method).toBe('ui/update-model-context')
  })

  it('accepts ui/open-chat with no params, defaulting them', () => {
    const parsed = parseGuestMessage({
      jsonrpc: '2.0',
      protocol: miniAppProtocolMarker,
      id: 'a',
      method: 'ui/open-chat',
    })
    expect(parsed?.method).toBe('ui/open-chat')
  })

  it('carries optional data and selection through untouched', () => {
    const selection = { row: 3 }
    const data = { quarters: [1, 2, 3] }
    const parsed = parseGuestMessage({
      ...contextUpdate,
      params: { context: { title: 'Q3', summary: 's', data, selection } },
    })
    expect(parsed).not.toBeNull()
    if (parsed?.method !== 'ui/update-model-context') {
      throw new Error('expected a ui/update-model-context')
    }
    expect(parsed.params.context.selection).toEqual(selection)
    expect(parsed.params.context.data).toEqual(data)
  })

  // The bus carries React DevTools, Vite HMR and extension traffic — anything
  // unmarked must be ignored rather than parsed.
  it.each([
    ['a non-object', 'hello'],
    ['null', null],
    ['a message with no protocol marker', { jsonrpc: '2.0', method: 'ui/initialize', id: 1, params: {} }],
    ['a foreign protocol marker', { ...initialize, protocol: 'some-other-bridge' }],
  ])('rejects %s', (_label, payload) => {
    expect(parseGuestMessage(payload)).toBeNull()
  })

  it('rejects an unknown method even when correctly marked', () => {
    expect(parseGuestMessage({ ...initialize, method: 'app/deleteEverything' })).toBeNull()
  })

  it('rejects a ui/update-model-context whose context is missing required fields', () => {
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

describe('ui/notifications/selection-changed', () => {
  const selectionMessage = (selection: unknown) => ({
    jsonrpc: '2.0',
    protocol: miniAppProtocolMarker,
    method: 'ui/notifications/selection-changed',
    params: { selection },
  })

  it('accepts a selection with geometry', () => {
    const parsed = parseGuestMessage(
      selectionMessage({ text: 'gross profit', rect: { x: 1, y: 2, width: 3, height: 4 } }),
    )
    expect(parsed?.method).toBe('ui/notifications/selection-changed')
  })

  it('accepts a selection without geometry, for apps that cannot report it', () => {
    expect(parseGuestMessage(selectionMessage({ text: 'gross profit' }))).not.toBeNull()
  })

  // Null is how the guest says "the user deselected" — it must parse, not be
  // dropped, or the host's floating control would never dismiss.
  it('accepts an explicit null selection', () => {
    const parsed = parseGuestMessage(selectionMessage(null))
    expect(parsed).not.toBeNull()
    if (parsed?.method !== 'ui/notifications/selection-changed') {
      throw new Error('expected a ui/notifications/selection-changed')
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

describe('runtime error notification', () => {
  const errorNotification = (params: unknown) => ({
    jsonrpc: '2.0',
    protocol: miniAppProtocolMarker,
    method: 'ui/notifications/error',
    params,
  })

  /**
   * Artifacts already report runtime errors, so a broken artifact says so while
   * a broken app just sat there looking fine — the host cannot read
   * `window.onerror` inside a cross-origin frame (THU-852).
   */
  it('accepts an app reporting its own failure', () => {
    const parsed = parseGuestMessage(errorNotification({ message: 'TypeError: x is not a function' }))

    expect(parsed?.method).toBe('ui/notifications/error')
  })

  it('rejects an empty message, which would render as a blank strip', () => {
    expect(parseGuestMessage(errorNotification({ message: '' }))).toBeNull()
  })

  /** It lands in a one-line strip, and an untrusted frame should not be able to
   *  hand us an unbounded string to hold. */
  it('rejects a message too long for the strip', () => {
    expect(parseGuestMessage(errorNotification({ message: 'x'.repeat(501) }))).toBeNull()
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

  /**
   * JSON-RPC replies carry exactly one of `result` or `error`. Rejecting the
   * error form left the request unsettled until its timeout, so an app that
   * correctly reported a failure was indistinguishable from an app that had
   * stopped answering — fifteen seconds later.
   */
  it('reads a reported failure rather than discarding the reply', () => {
    const failure = {
      jsonrpc: '2.0',
      protocol: miniAppProtocolMarker,
      id: 7,
      error: { code: -32000, message: 'set_assumption threw' },
    }

    expect(parseGuestResult(failure)).toEqual({
      id: 7,
      result: undefined,
      error: { code: -32000, message: 'set_assumption threw' },
    })
  })

  it('rejects a malformed error object rather than trusting it', () => {
    const bad = { jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: 7, error: { code: 'nope' } }

    expect(parseGuestResult(bad)).toBeNull()
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
