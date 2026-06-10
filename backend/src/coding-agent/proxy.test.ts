/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { CodingAgentProxy, type UpstreamSocket } from './proxy'

const makeFakeUpstream = () => {
  const listeners: Record<string, ((event: { data?: unknown; code?: number; reason?: string }) => void)[]> = {}
  const sent: string[] = []
  let closedWith: { code?: number; reason?: string } | null = null

  const sock: UpstreamSocket = {
    readyState: 0, // CONNECTING
    send: (data) => sent.push(data),
    close: (code, reason) => {
      closedWith = { code, reason }
    },
    addEventListener: (type, listener) => {
      ;(listeners[type] ??= []).push(listener)
    },
  }
  const emit = (type: string, event: { data?: unknown; code?: number; reason?: string } = {}) =>
    (listeners[type] ?? []).forEach((l) => l(event))

  return {
    sock,
    sent,
    get closedWith() {
      return closedWith
    },
    emit,
    open: () => {
      sock.readyState = 1
      emit('open')
    },
  }
}

const makeProxy = () => {
  const up = makeFakeUpstream()
  const toClient: string[] = []
  const closes: { code: number; reason: string }[] = []
  const proxy = new CodingAgentProxy({
    send: (d) => toClient.push(d),
    onUpstreamClose: (code, reason) => closes.push({ code, reason }),
    upstreamUrl: 'wss://workspace.example/?token=x',
    createUpstream: () => up.sock,
  })
  return { proxy, up, toClient, closes }
}

describe('CodingAgentProxy', () => {
  it('buffers client frames until the upstream opens, then flushes them in order', () => {
    const { proxy, up } = makeProxy()
    proxy.handleClientMessage('a')
    proxy.handleClientMessage('b')
    expect(up.sent).toEqual([]) // not connected yet

    up.open()
    expect(up.sent).toEqual(['a', 'b'])
  })

  it('forwards client frames immediately once open', () => {
    const { proxy, up } = makeProxy()
    up.open()
    proxy.handleClientMessage('c')
    expect(up.sent).toEqual(['c'])
  })

  it('pipes upstream messages back to the client', () => {
    const { up, toClient } = makeProxy()
    up.open()
    up.emit('message', { data: 'from-agent' })
    expect(toClient).toEqual(['from-agent'])
  })

  it('reports upstream close/error to the route', () => {
    const { up, closes } = makeProxy()
    up.emit('close', { code: 1006, reason: 'gone' })
    expect(closes).toEqual([{ code: 1006, reason: 'gone' }])
  })

  it('dispose() closes the upstream and suppresses the close callback', () => {
    const { proxy, up, closes } = makeProxy()
    proxy.dispose()
    expect(up.closedWith).toEqual({ code: 1000, reason: 'client disconnected' })
    up.emit('close', { code: 1000, reason: 'client disconnected' })
    expect(closes).toEqual([]) // suppressed after dispose
  })
})
