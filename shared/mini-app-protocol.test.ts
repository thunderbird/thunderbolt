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
  parseToolsList,
  maxToolDescriptionChars,
  maxToolsPerApp,
  elementAtResultSchema,
  toolsCallResultSchema,
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

  /*
   * The guests report `window.getSelection().toString()` verbatim, so a
   * select-all in a long view runs past the cap. Rejecting dropped the whole
   * notification: "Ask about this" never appeared, and — because a deselect is
   * the same message shape — a stale control could strand itself on screen.
   */
  it('clamps an over-long selection instead of dropping the notification', () => {
    const parsed = parseGuestMessage(selectionMessage({ text: 'a'.repeat(20_001) }))

    if (parsed?.method !== 'ui/notifications/selection-changed') {
      throw new Error('expected a ui/notifications/selection-changed')
    }
    expect(parsed.params.selection?.text).toHaveLength(20_000)
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
})

describe('parseGuestResult', () => {
  const reply = { jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: 7, result: { items: [] } }

  it('reads a reply and its id', () => {
    expect(parseGuestResult(reply)).toEqual({ id: 7, result: { items: [] } })
  })

  /**
   * The regression that broke the handshake. `result` had been required, which
   * discriminated replies from requests by accident; making it optional so a
   * reported failure could be read turned this into a wildcard, and the bridge
   * checks for a reply *first* — so `ui/initialize` itself was swallowed and no
   * app could ever connect.
   */
  it('is not fooled by a guest request that happens to carry a numeric id', () => {
    for (const method of ['ui/initialize', 'ui/open-chat', 'ui/request-auth-token']) {
      const request = { jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: 1, method, params: {} }

      expect(parseGuestResult(request)).toBeNull()
    }
  })

  it('ignores a bare id with neither result nor error', () => {
    expect(parseGuestResult({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: 1 })).toBeNull()
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

describe('elementAtResultSchema', () => {
  const rect = { x: 4, y: 8, width: 100, height: 40 }
  const element = { id: 'a', label: 'Q3 row', text: 'Revenue: 4.2M', rect }

  it('reads the element under the pointer', () => {
    const parsed = elementAtResultSchema.safeParse({ element })
    expect(parsed.success && parsed.data.element).toEqual(element)
  })

  /** Over padding or a background there is nothing to outline, and that is a
   *  normal answer rather than a failure. */
  it('accepts null for nothing there', () => {
    const parsed = elementAtResultSchema.safeParse({ element: null })
    expect(parsed.success && parsed.data.element).toBeNull()
  })

  /*
   * Same lesson as parseToolsList: the guests build `text` from a whole table
   * row and clamp nothing, so an over-long one used to cost the entire answer.
   * Here that would mean the outline never appearing over exactly the
   * content-dense views the gesture is for.
   */
  it('clamps an over-long text instead of rejecting the element', () => {
    const parsed = elementAtResultSchema.safeParse({ element: { ...element, text: 'x'.repeat(20_001) } })
    expect(parsed.success && parsed.data.element?.text).toHaveLength(20_000)
  })

  it('rejects an element with no geometry to draw', () => {
    expect(elementAtResultSchema.safeParse({ element: { ...element, rect: undefined } }).success).toBe(false)
  })

  it('rejects a NaN coordinate rather than drawing at NaN', () => {
    const hostile = { element: { ...element, rect: { ...rect, x: Number.NaN } } }
    expect(elementAtResultSchema.safeParse(hostile).success).toBe(false)
  })

  /*
   * Pins the property, not the implementation: zod 4 rejects Infinity from a
   * bare `z.number()` anyway, so this passes with or without the explicit
   * `.finite()`. It is here because "coordinates are finite" is part of the
   * protocol — an infinite one reaches the overlay as `left: Infinity` and
   * draws the outline nowhere — and that has to survive a zod change.
   */
  it('rejects an infinite coordinate, which a bare number schema would allow', () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const hostile = { element: { ...element, rect: { ...rect, x: value } } }
      expect(elementAtResultSchema.safeParse(hostile).success).toBe(false)
    }
  })

  it('rejects an infinite width, not just an infinite origin', () => {
    const hostile = { element: { ...element, rect: { ...rect, width: Number.POSITIVE_INFINITY } } }
    expect(elementAtResultSchema.safeParse(hostile).success).toBe(false)
  })
})

describe('parseToolsList', () => {
  const tool = (overrides: Record<string, unknown> = {}) => ({
    name: 'set_assumption',
    description: 'Change one input of the model.',
    ...overrides,
  })

  it('reads a well-formed list', () => {
    expect(parseToolsList({ tools: [tool()] })).toEqual({ tools: [tool()], dropped: 0 })
  })

  /*
   * The bug this exists for: the finance sample's description ran 386 characters
   * against a 300 cap, the whole array failed to parse, and the app silently had
   * no tools at all. One long sentence must not disable an app.
   */
  it('truncates an over-long description instead of dropping the tool', () => {
    const long = 'x'.repeat(500)
    const { tools, dropped } = parseToolsList({ tools: [tool({ description: long })] })

    expect(dropped).toBe(0)
    expect(tools).toHaveLength(1)
    expect(tools[0].description).toHaveLength(maxToolDescriptionChars)
  })

  it('keeps the good tools when one descriptor is genuinely malformed', () => {
    const { tools, dropped } = parseToolsList({ tools: [tool(), tool({ name: 'has spaces' })] })

    expect(tools.map((t) => t.name)).toEqual(['set_assumption'])
    expect(dropped).toBe(1)
  })

  it('reports an empty description as dropped rather than padding it', () => {
    expect(parseToolsList({ tools: [tool({ description: '' })] })).toEqual({ tools: [], dropped: 1 })
  })

  /*
   * The same all-or-nothing shape one level up from the description bug: capping
   * the envelope on `maxToolsPerApp` meant an app advertising one tool too many
   * lost every one of them, and `dropped: 0` kept even the log quiet.
   */
  it('slices past the per-app cap rather than dropping every tool', () => {
    const many = Array.from({ length: maxToolsPerApp + 2 }, (_, index) => tool({ name: `tool_${index}` }))
    const { tools, dropped } = parseToolsList({ tools: many })

    expect(tools).toHaveLength(maxToolsPerApp)
    expect(dropped).toBe(2)
  })

  it('returns nothing for a reply that is not a tool list', () => {
    expect(parseToolsList({ nope: true })).toEqual({ tools: [], dropped: 0 })
  })
})

/*
 * Every bound below guards a field the guest sends unclamped, so rejecting on
 * length is rejecting the message. Each of these was a way for the feature to
 * silently do nothing.
 */
describe('bounds clamp rather than reject', () => {
  const guestMessage = (method: string, params: unknown) => ({
    jsonrpc: '2.0',
    protocol: miniAppProtocolMarker,
    id: 3,
    method,
    params,
  })

  it('clamps a summary an app built from its own data', () => {
    const parsed = parseGuestMessage(
      guestMessage('ui/update-model-context', { context: { title: 'Q3', summary: 'x'.repeat(20_001) } }),
    )

    if (parsed?.method !== 'ui/update-model-context') {
      throw new Error('expected a ui/update-model-context')
    }
    expect(parsed.params.context.summary).toHaveLength(20_000)
  })

  it('clamps a title rather than losing the context update', () => {
    const parsed = parseGuestMessage(
      guestMessage('ui/update-model-context', { context: { title: 'x'.repeat(201), summary: 'ok' } }),
    )

    if (parsed?.method !== 'ui/update-model-context') {
      throw new Error('expected a ui/update-model-context')
    }
    expect(parsed.params.context.title).toHaveLength(200)
  })

  // The worst of them: this one rode the handshake, so a long display name meant
  // the app never connected at all and both sides saw only a timeout.
  it('clamps an app name rather than dropping the handshake', () => {
    const parsed = parseGuestMessage(
      guestMessage('ui/initialize', { protocolVersion: 1, appName: 'x'.repeat(201), capabilities: {} }),
    )

    if (parsed?.method !== 'ui/initialize') {
      throw new Error('expected a ui/initialize')
    }
    expect(parsed.params.appName).toHaveLength(200)
  })

  it('clamps an open-chat prompt rather than never opening the chat', () => {
    const parsed = parseGuestMessage(guestMessage('ui/open-chat', { prompt: 'x'.repeat(10_001) }))

    if (parsed?.method !== 'ui/open-chat') {
      throw new Error('expected a ui/open-chat')
    }
    expect(parsed.params.prompt).toHaveLength(10_000)
  })

  it('clamps a runtime error rather than staying silent about a crash', () => {
    const parsed = parseGuestMessage({
      jsonrpc: '2.0',
      protocol: miniAppProtocolMarker,
      method: 'ui/notifications/error',
      params: { message: 'x'.repeat(501) },
    })

    if (parsed?.method !== 'ui/notifications/error') {
      throw new Error('expected a ui/notifications/error')
    }
    expect(parsed.params.message).toHaveLength(500)
  })

  // Rejecting here actively lied: the tool ran and mutated the app, and the host
  // told the model it "may have timed out" — an invitation to run it again.
  it('clamps a large tool result rather than reporting the call as failed', () => {
    const parsed = toolsCallResultSchema.safeParse({ content: 'x'.repeat(100_001) })

    expect(parsed.success).toBe(true)
    expect(parsed.data?.content).toHaveLength(100_000)
  })

  it('clamps a reported error rather than leaving the request unsettled', () => {
    const reply = parseGuestResult({
      jsonrpc: '2.0',
      protocol: miniAppProtocolMarker,
      id: 7,
      error: { code: -32000, message: 'x'.repeat(2_001) },
    })

    expect(reply?.error?.message).toHaveLength(2_000)
  })
})
