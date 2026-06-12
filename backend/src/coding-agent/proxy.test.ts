/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { CodingAgentProxy, type UpstreamSocket } from './proxy'

const makeFakeUpstream = () => {
  const listeners: Record<string, ((event: { data?: unknown; code?: number; reason?: string }) => void)[]> = {}
  const sent: string[] = []
  let closedWith: { code?: number; reason?: string } | null = null
  let throwOnSend = false

  const sock: UpstreamSocket = {
    readyState: 0, // CONNECTING
    send: (data) => {
      if (throwOnSend) {
        throw new Error('send failed')
      }
      sent.push(data)
    },
    close: (code, reason) => {
      closedWith = { code, reason }
    },
    addEventListener: (type, listener) => {
      ;(listeners[type] ??= []).push(listener)
    },
  }

  return {
    sock,
    sent,
    get closedWith() {
      return closedWith
    },
    setThrowOnSend: (v: boolean) => {
      throwOnSend = v
    },
    emit: (type: string, event: { data?: unknown; code?: number; reason?: string } = {}) =>
      (listeners[type] ?? []).forEach((l) => l(event)),
    open: () => {
      sock.readyState = 1
      ;(listeners.open ?? []).forEach((l) => l({}))
    },
  }
}

const makeProxy = (opts: { queueMessages?: number; queueBytes?: number } = {}) => {
  const up = makeFakeUpstream()
  const toClient: string[] = []
  const closes: { code: number; reason: string }[] = []
  const logs: { event: string; detail: Record<string, unknown> }[] = []
  let timerFn: (() => void) | null = null
  const proxy = new CodingAgentProxy({
    send: (d) => toClient.push(d),
    onClose: (code, reason) => closes.push({ code, reason }),
    onLog: (event, detail) => logs.push({ event, detail }),
    upstreamUrl: 'wss://workspace.example/?token=x',
    createUpstream: () => up.sock,
    queueMessages: opts.queueMessages,
    queueBytes: opts.queueBytes,
    setTimer: (fn) => {
      timerFn = fn
      return 1
    },
    clearTimer: () => {
      timerFn = null
    },
  })
  return { proxy, up, toClient, closes, logs, fireTimer: () => timerFn?.(), hasTimer: () => timerFn !== null }
}

describe('CodingAgentProxy', () => {
  it('buffers client frames until the upstream opens, then flushes them in order', () => {
    const { proxy, up } = makeProxy()
    proxy.handleClientMessage('a')
    proxy.handleClientMessage('b')
    expect(up.sent).toEqual([])
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

  it('stringifies non-string upstream messages', () => {
    const { up, toClient } = makeProxy()
    up.open()
    up.emit('message', { data: { hello: 1 } })
    expect(toClient).toEqual(['{"hello":1}'])
  })

  it('on upstream close, passes a sendable code with a GENERIC reason and logs the real one', () => {
    const { up, closes, logs } = makeProxy()
    up.emit('close', { code: 1011, reason: 'internal shim detail' })
    expect(closes).toEqual([{ code: 1011, reason: 'upstream closed' }]) // reason NOT relayed verbatim
    expect(logs.some((l) => l.detail.reason === 'internal shim detail')).toBe(true) // logged server-side
  })

  it('substitutes a reserved abnormal close code (1006) with 1011', () => {
    const { up, closes } = makeProxy()
    up.emit('close', { code: 1006 })
    expect(closes[0].code).toBe(1011)
  })

  it('defaults a missing upstream close code to 1011', () => {
    const { up, closes } = makeProxy()
    up.emit('close', {})
    expect(closes).toEqual([{ code: 1011, reason: 'upstream closed' }])
  })

  it('on upstream error, closes the client 1011', () => {
    const { up, closes } = makeProxy()
    up.emit('error')
    expect(closes).toEqual([{ code: 1011, reason: 'upstream error' }])
  })

  it('arms a connect timer and clears it on open', () => {
    const { up, hasTimer } = makeProxy()
    expect(hasTimer()).toBe(true)
    up.open()
    expect(hasTimer()).toBe(false)
  })

  it('connect timeout tears down with 1011 when the upstream never opens', () => {
    const { up, closes, fireTimer } = makeProxy()
    fireTimer()
    expect(closes).toEqual([{ code: 1011, reason: 'upstream unavailable' }])
    expect(up.closedWith).not.toBeNull()
  })

  it('caps the pre-connect queue and overflows with 4008', () => {
    const { proxy, up, closes } = makeProxy({ queueMessages: 2 })
    proxy.handleClientMessage('a')
    proxy.handleClientMessage('b')
    proxy.handleClientMessage('c') // exceeds cap of 2
    expect(closes).toEqual([{ code: 4008, reason: 'pre-connect queue overflow' }])
    expect(up.closedWith).not.toBeNull()
  })

  it('dispose() closes the upstream and suppresses the close callback', () => {
    const { proxy, up, closes } = makeProxy()
    proxy.dispose()
    expect(up.closedWith).toEqual({ code: 1000, reason: 'client disconnected' })
    up.emit('close', { code: 1000 })
    expect(closes).toEqual([]) // suppressed after dispose
  })

  it('ignores client frames and upstream messages after dispose', () => {
    const { proxy, up, toClient } = makeProxy()
    up.open()
    proxy.dispose()
    proxy.handleClientMessage('x')
    up.emit('message', { data: 'y' })
    expect(up.sent).toEqual([])
    expect(toClient).toEqual([])
  })

  it('open after dispose closes the upstream without flushing buffered frames', () => {
    const { proxy, up } = makeProxy()
    proxy.handleClientMessage('a')
    proxy.dispose()
    up.open()
    expect(up.sent).toEqual([])
  })

  it('swallows an upstream send throw without crashing', () => {
    const { proxy, up } = makeProxy()
    up.open()
    up.setThrowOnSend(true)
    expect(() => proxy.handleClientMessage('x')).not.toThrow()
  })

  for (const reserved of [1005, 1006, 1015]) {
    it(`substitutes reserved abnormal close code ${reserved} with 1011`, () => {
      const { up, closes } = makeProxy()
      up.emit('close', { code: reserved })
      expect(closes[0].code).toBe(1011)
    })
  }

  it('passes non-reserved upstream close codes through unchanged', () => {
    const { up, closes } = makeProxy()
    up.emit('close', { code: 4567 }) // app-range code survives
    expect(closes[0].code).toBe(4567)
  })

  it('overflows on the byte budget (queueBytes), counting Buffer.byteLength', () => {
    const { proxy, closes } = makeProxy({ queueMessages: 100, queueBytes: 4 })
    proxy.handleClientMessage('abc') // 3 bytes — within budget
    expect(closes).toEqual([])
    proxy.handleClientMessage('de') // 3 + 2 = 5 > 4 — overflow
    expect(closes).toEqual([{ code: 4008, reason: 'pre-connect queue overflow' }])
  })
})
