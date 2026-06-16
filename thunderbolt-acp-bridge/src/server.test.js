/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { startBridge } from './server.js'
import { createLogger } from './log.js'

/**
 * A fake child process: pipes for stdin/stdout, emits exit/error.
 *
 * @param {{ ignoreSigterm?: boolean }} [opts] - when ignoreSigterm is set, the
 *   child records the signal but does NOT die on SIGTERM (it only dies on
 *   SIGKILL), modeling a stubborn agent so the escalation path can be tested.
 */
const makeFakeChild = ({ ignoreSigterm = false } = {}) => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdin = Object.assign(new EventEmitter(), {
    written: [],
    write(chunk) {
      this.written.push(chunk)
      return true
    },
  })
  child.stdout = new EventEmitter()
  child.killed = []
  child.kill = (sig) => {
    child.killed.push(sig)
    if (sig === 'SIGTERM' && ignoreSigterm) return true
    // A real child dies asynchronously, then Node emits 'exit'. Mirror that.
    child.exitCode = 0
    child.signalCode = sig
    queueMicrotask(() => child.emit('exit', 0, sig))
    return true
  }
  return child
}

const ALLOWED_ORIGIN = 'https://app.thunderbolt.io'

/** A fake WebSocketServer that lets the test drive listening/connection. */
const makeFakeWss = (port) => {
  const wss = new EventEmitter()
  wss.closed = false
  wss.address = () => ({ port })
  wss.close = () => {
    wss.closed = true
  }
  return wss
}

/**
 * A fake readline interface over a stream. Models real readline+pipe
 * backpressure: pause()/resume() record being called AND gate 'line' emission —
 * while paused, any emitted line is queued and replayed in order on resume.
 * Unpaused, lines emit immediately, so existing tests are unaffected.
 */
const makeFakeLineReader = (stream) => {
  const lines = new EventEmitter()
  lines.paused = false
  lines.pauseCalls = 0
  lines.resumeCalls = 0
  const queue = []
  const rawEmit = lines.emit.bind(lines)
  lines.emit = (event, ...args) => {
    if (event === 'line' && lines.paused) {
      queue.push(args)
      return true
    }
    return rawEmit(event, ...args)
  }
  lines.pause = () => {
    lines.paused = true
    lines.pauseCalls += 1
  }
  lines.resume = () => {
    lines.paused = false
    lines.resumeCalls += 1
    while (queue.length > 0) rawEmit('line', ...queue.shift())
  }
  stream.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) lines.emit('line', line)
  })
  return lines
}

const makeFakeSocket = () => {
  const socket = new EventEmitter()
  socket.readyState = 1 // OPEN
  socket.sent = []
  socket.closedWith = null
  socket.send = (line) => socket.sent.push(line)
  socket.close = (code) => {
    socket.closedWith = code
  }
  return socket
}

const quietLogger = () => createLogger({ stream: { write: () => {} } })

/** Drive a bridge to "ready" and return all the moving parts. */
const startReady = async ({ port = 5000, grace = 800, child = makeFakeChild(), cfg = {} } = {}) => {
  const wss = makeFakeWss(port)
  let exited = null
  let stopFn = null
  let banner = null
  let lines = null

  const promise = startBridge(
    { agentCmd: ['my-agent', '--flag'], host: '127.0.0.1', port: 0, logger: quietLogger(), ...cfg },
    {
      spawn: () => child,
      WebSocketServer: function () {
        return wss
      },
      createLineReader: (stream) => {
        lines = makeFakeLineReader(stream)
        return lines
      },
      onBanner: (url) => {
        banner = url
      },
      onStop: (stop) => {
        stopFn = stop
      },
      exit: (code) => {
        exited = code
      },
    },
  )

  // Server reports listening, then the grace timer fires.
  wss.emit('listening')
  await new Promise((r) => setTimeout(r, grace))
  await promise

  return {
    child,
    wss,
    getExit: () => exited,
    getStop: () => stopFn,
    getBanner: () => banner,
    getLines: () => lines,
  }
}

/** Open an allowed connection (default Thunderbolt origin) on a ready bridge. */
const connect = (wss, { origin = ALLOWED_ORIGIN } = {}) => {
  const socket = makeFakeSocket()
  const headers = origin === undefined ? {} : { origin }
  wss.emit('connection', socket, { headers })
  return socket
}

describe('startBridge lifecycle', () => {
  it('prints the banner with the resolved ephemeral port after grace', async () => {
    const { getBanner } = await startReady({ port: 54321 })
    expect(getBanner()).toBe('ws://127.0.0.1:54321')
  })

  it('brackets an IPv6 literal host in the banner URL (RFC 3986), unbracketed for IPv4', async () => {
    const ipv6 = await startReady({ port: 54321, cfg: { host: '::1' } })
    // Without brackets this would be the malformed ws://::1:54321.
    expect(ipv6.getBanner()).toBe('ws://[::1]:54321')

    const ipv4 = await startReady({ port: 54321, cfg: { host: '127.0.0.1' } })
    expect(ipv4.getBanner()).toBe('ws://127.0.0.1:54321') // no brackets, regression guard

    // An already-bracketed IPv6 literal must NOT be wrapped again (no ws://[[::1]]:PORT).
    const bracketed = await startReady({ port: 54321, cfg: { host: '[::1]' } })
    expect(bracketed.getBanner()).toBe('ws://[::1]:54321')
  })

  it('relays agent stdout lines to the connected socket', async () => {
    const { child, wss } = await startReady()
    const socket = connect(wss)

    child.stdout.emit('data', '{"id":1}\n{"id":2}\nplain log\n')
    expect(socket.sent).toEqual(['{"id":1}', '{"id":2}']) // non-JSON dropped
  })

  it('relays socket messages to agent stdin with a trailing newline', async () => {
    const { child, wss } = await startReady()
    // A missing Origin is allowed (native/Tauri webviews send none).
    const socket = connect(wss, { origin: undefined })

    socket.emit('message', '{"id":9}')
    expect(child.stdin.written).toEqual(['{"id":9}\n'])
  })

  it('reuses the single child across reconnects', async () => {
    const { child, wss } = await startReady()
    const first = connect(wss)
    first.emit('close', 1000)

    const second = connect(wss)
    child.stdout.emit('data', '{"id":3}\n')

    expect(second.sent).toEqual(['{"id":3}'])
    expect(first.sent).toEqual([]) // old socket no longer receives
  })

  it('holds agent output across a reconnect instead of dropping it (pause/resume backpressure)', async () => {
    const { child, wss, getLines } = await startReady()
    const first = connect(wss)
    const lines = getLines()

    // Client briefly disconnects (e.g. Thunderbolt's reconnect backoff).
    first.emit('close', 1000)
    expect(lines.pauseCalls).toBe(1) // reader paused so output isn't dropped

    // The agent emits an in-flight response WHILE no client is connected.
    child.stdout.emit('data', '{"id":42}\n')
    expect(first.sent).toEqual([]) // not delivered to the gone socket — held, not dropped

    // The client reconnects: the reader resumes and drains the held line in order.
    const second = connect(wss)
    expect(lines.resumeCalls).toBe(1)
    expect(second.sent).toEqual(['{"id":42}']) // the in-flight response survived the disconnect
  })

  it('supersedes a previous connection: closes the old socket 1000, new becomes active', async () => {
    const { child, wss } = await startReady()
    const first = connect(wss)
    const second = connect(wss)

    // Newest-wins: the old socket is closed, only the new one receives output.
    expect(first.closedWith).toBe(1000)
    expect(second.closedWith).toBeNull()
    child.stdout.emit('data', '{"id":4}\n')
    expect(second.sent).toEqual(['{"id":4}'])
    expect(first.sent).toEqual([])
  })

  it('a superseded socket can no longer inject into agent stdin, only the newest can', async () => {
    const { child, wss } = await startReady()
    const first = connect(wss)
    const second = connect(wss)

    // close() doesn't synchronously stop buffered events — a stale socket emitting
    // 'message' must be dropped, while the active socket still reaches stdin.
    first.emit('message', '{"stale":true}')
    second.emit('message', '{"id":7}')
    expect(child.stdin.written).toEqual(['{"id":7}\n'])
  })

  it('stop() closes ws with 1000, SIGTERMs the child, and exits 130 once it dies', async () => {
    const { child, wss, getStop, getExit } = await startReady()
    const socket = connect(wss)

    getStop()('signal', 130)
    expect(socket.closedWith).toBe(1000)
    expect(wss.closed).toBe(true)
    expect(child.killed).toContain('SIGTERM')
    // Exit is deferred until the child actually exits (driven by child 'exit').
    await new Promise((r) => setTimeout(r, 0))
    expect(getExit()).toBe(130)
  })

  it('stop() SIGKILLs a stubborn child that ignores SIGTERM, then exits', async () => {
    const stubborn = makeFakeChild({ ignoreSigterm: true })
    const { getStop, getExit } = await startReady({ child: stubborn })

    getStop()('signal', 130)
    expect(stubborn.killed).toContain('SIGTERM')
    await new Promise((r) => setTimeout(r, 0))
    expect(getExit()).toBeNull() // SIGTERM ignored → not dead yet, no exit

    // Fast-forward past the 2s escalation window → SIGKILL + forced exit.
    await new Promise((r) => setTimeout(r, 2100))
    expect(stubborn.killed).toContain('SIGKILL')
    expect(getExit()).toBe(130)
  })

  it('child early-exit before ready rejects with exit 69', async () => {
    const child = makeFakeChild()
    const wss = makeFakeWss(6000)
    let exited = null

    const promise = startBridge(
      { agentCmd: ['broken-agent'], host: '127.0.0.1', port: 0, logger: quietLogger() },
      {
        spawn: () => child,
        WebSocketServer: function () {
          return wss
        },
        createLineReader: () => new EventEmitter(),
        exit: (code) => {
          exited = code
        },
      },
    )

    wss.emit('listening')
    // Child dies during the grace window, before the banner.
    child.emit('exit', 1, null)

    await expect(promise).rejects.toMatchObject({ exitCode: 69 })
    expect(exited).toBe(69)
  })

  it('spawn ENOENT rejects with exit 69', async () => {
    const child = makeFakeChild()
    const wss = makeFakeWss(6001)
    let exited = null

    const promise = startBridge(
      { agentCmd: ['nope'], host: '127.0.0.1', port: 0, logger: quietLogger() },
      {
        spawn: () => child,
        WebSocketServer: function () {
          return wss
        },
        createLineReader: () => new EventEmitter(),
        exit: (code) => {
          exited = code
        },
      },
    )

    child.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }))

    await expect(promise).rejects.toMatchObject({ exitCode: 69 })
    expect(exited).toBe(69)
  })

  it('server EADDRINUSE rejects with exit 69', async () => {
    const child = makeFakeChild()
    const wss = makeFakeWss(6002)
    let exited = null

    const promise = startBridge(
      { agentCmd: ['agent'], host: '127.0.0.1', port: 8080, logger: quietLogger() },
      {
        spawn: () => child,
        WebSocketServer: function () {
          return wss
        },
        createLineReader: () => new EventEmitter(),
        exit: (code) => {
          exited = code
        },
      },
    )

    wss.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))

    await expect(promise).rejects.toMatchObject({ exitCode: 69 })
    expect(exited).toBe(69)
  })

  it('SIGKILLs a still-alive child on a fatal server bind error (never orphaned)', async () => {
    const child = makeFakeChild() // alive: exitCode === null, signalCode === null
    const wss = makeFakeWss(6003)
    let exited = null

    const promise = startBridge(
      { agentCmd: ['agent'], host: '127.0.0.1', port: 8080, logger: quietLogger() },
      {
        spawn: () => child,
        WebSocketServer: function () {
          return wss
        },
        createLineReader: () => new EventEmitter(),
        exit: (code) => {
          exited = code
        },
      },
    )

    wss.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))

    await expect(promise).rejects.toMatchObject({ exitCode: 69 })
    expect(child.killed).toContain('SIGKILL') // child reaped before exit, not orphaned
    expect(exited).toBe(69)
  })

  it('agent clean-exits (0, null) after ready → exit 0', async () => {
    const { child, getExit } = await startReady()

    child.emit('exit', 0, null)
    await new Promise((r) => setTimeout(r, 0))
    expect(getExit()).toBe(0)
  })

  it('agent dies by signal (null, SIGKILL) after ready → exit 69, not 0', async () => {
    const { child, getExit } = await startReady()

    // A signal death surfaces as code === null + signal set — an abnormal exit
    // that must map to unavailable (69), never to ok (0).
    child.emit('exit', null, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 0))
    expect(getExit()).toBe(69)
  })

  it('agent exits non-zero (1, null) after ready → exit 69', async () => {
    const { child, getExit } = await startReady()

    child.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 0))
    expect(getExit()).toBe(69)
  })
})

describe('startBridge — Origin allowlist (cross-origin hijack guard)', () => {
  it('accepts an allowed Thunderbolt origin', async () => {
    const { child, wss } = await startReady()
    const socket = connect(wss, { origin: 'https://app.thunderbolt.io' })

    expect(socket.closedWith).toBeNull()
    child.stdout.emit('data', '{"id":1}\n')
    expect(socket.sent).toEqual(['{"id":1}'])
  })

  it('rejects a disallowed origin with close code 1008 and forwards nothing', async () => {
    const { child, wss } = await startReady()
    const socket = connect(wss, { origin: 'https://evil.example' })

    expect(socket.closedWith).toBe(1008)
    child.stdout.emit('data', '{"id":1}\n')
    expect(socket.sent).toEqual([]) // never wired up
  })

  it('allows a missing/empty origin (native + Tauri webviews send none)', async () => {
    const { child, wss } = await startReady()
    const socket = connect(wss, { origin: undefined })

    expect(socket.closedWith).toBeNull()
    child.stdout.emit('data', '{"id":1}\n')
    expect(socket.sent).toEqual(['{"id":1}'])
  })

  it('--allow-origin extends the allowlist', async () => {
    const { wss } = await startReady({ cfg: { allowOrigins: ['http://localhost:9999'] } })
    const socket = connect(wss, { origin: 'http://localhost:9999' })
    expect(socket.closedWith).toBeNull()
  })

  it('--allow-any-origin accepts everything and warns once at startup', async () => {
    const warned = []
    const logger = createLogger({ stream: { write: (s) => warned.push(s) } })
    const { wss } = await startReady({ cfg: { allowAnyOrigin: true, logger } })

    const socket = connect(wss, { origin: 'https://evil.example' })
    expect(socket.closedWith).toBeNull() // accepted despite a junk origin

    expect(warned.some((line) => line.includes('origin-check-disabled'))).toBe(true)
  })
})

describe('startBridge — dropped non-JSON line never logs content', () => {
  it('logs only lifecycle + byteSize for a dropped stdout line, never the text', async () => {
    const logged = []
    const logger = createLogger({ verbose: true, stream: { write: (s) => logged.push(s) } })
    const { child, wss } = await startReady({ cfg: { logger } })
    connect(wss)

    const secret = 'WARN booting with token=sk-deadbeef-secret'
    child.stdout.emit('data', `${secret}\n`)

    const all = logged.join('')
    expect(all).toContain('dropped-non-json')
    expect(all).toContain(`byteSize=${Buffer.byteLength(secret)}`)
    expect(all).not.toContain('sk-deadbeef-secret')
    expect(all).not.toContain('token=')
  })
})
