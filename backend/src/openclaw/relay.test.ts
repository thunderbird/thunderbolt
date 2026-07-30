/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { createSandboxRelay, type UpstreamSocket } from './relay'

/** Fake upstream socket that lets tests drive open/message/close by hand. */
const fakeUpstream = () => {
  const listeners: Record<string, ((event: { data?: unknown }) => void)[]> = {}
  const sent: string[] = []
  let closed = false
  const socket: UpstreamSocket = {
    readyState: 0,
    send: (data) => sent.push(data),
    close: () => {
      closed = true
    },
    addEventListener: (type, listener) => {
      ;(listeners[type] ??= []).push(listener)
    },
  }
  const emit = (type: string, event: { data?: unknown } = {}) => {
    for (const l of listeners[type] ?? []) {
      l(event)
    }
  }
  return { socket, sent, emit, isClosed: () => closed }
}

describe('createSandboxRelay', () => {
  test('queues browser frames until upstream opens, then flushes in order', () => {
    const up = fakeUpstream()
    const relay = createSandboxRelay(
      'ws://x',
      () => {},
      () => {},
      { connect: () => up.socket },
    )

    relay.fromBrowser('a')
    relay.fromBrowser('b')
    expect(up.sent).toEqual([]) // not open yet

    up.socket.readyState = 1
    up.emit('open')
    expect(up.sent).toEqual(['a', 'b'])

    relay.fromBrowser('c')
    expect(up.sent).toEqual(['a', 'b', 'c']) // sent immediately once open
  })

  test('forwards upstream messages to the browser', () => {
    const up = fakeUpstream()
    const received: string[] = []
    createSandboxRelay(
      'ws://x',
      (data) => received.push(data),
      () => {},
      { connect: () => up.socket },
    )

    up.emit('message', { data: '{"jsonrpc":"2.0"}' })
    expect(received).toEqual(['{"jsonrpc":"2.0"}'])
  })

  test('notifies on upstream close and close() tears down upstream', () => {
    const up = fakeUpstream()
    let upstreamClosed = false
    const relay = createSandboxRelay(
      'ws://x',
      () => {},
      () => {
        upstreamClosed = true
      },
      { connect: () => up.socket },
    )

    up.emit('close')
    expect(upstreamClosed).toBe(true)

    relay.close()
    expect(up.isClosed()).toBe(true)
  })
})
