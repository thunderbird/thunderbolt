// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

'use strict'

const { test, expect, mock } = require('bun:test')
const { EventEmitter } = require('node:events')
const { startBridge, HIGH_WATER, LOW_WATER, CLOSE_NORMAL } = require('./server')

const OPEN = 1

/** Fake WebSocketServer: EventEmitter capturing its options, with address/close. */
const makeFakeWss = () => {
  let opts = null
  class FakeWss extends EventEmitter {
    constructor(o) {
      super()
      opts = o
      this._port = 5123
    }
    address() {
      return { port: this._port }
    }
    close(cb) {
      this.closed = true
      if (cb) cb()
    }
  }
  return { FakeWss, getOpts: () => opts }
}

/** Fake WS client socket. */
const makeFakeWs = (overrides = {}) => {
  const ws = new EventEmitter()
  ws.OPEN = OPEN
  ws.readyState = OPEN
  ws.bufferedAmount = 0
  ws.send = mock((data, cb) => {
    if (cb) cb()
  })
  ws.close = mock((code) => {
    ws.lastCloseCode = code
    ws.readyState = 3
  })
  ws.pause = mock(() => {})
  ws.resume = mock(() => {})
  return Object.assign(ws, overrides)
}

/** Fake supervisor captured so the test can drive child stdout/exit. */
const makeFakeSupervisor = () => {
  const stdin = new EventEmitter()
  stdin.destroyed = false
  const sup = {
    child: { stdin },
    onStdout: null,
    onExit: null,
    onSpawnError: null,
    writeStdin: mock(() => true),
    pauseStdout: mock(() => {}),
    resumeStdout: mock(() => {}),
    stop: mock(() => {}),
    kill: mock(() => {}),
    alive: () => true,
  }
  const factory = (args) => {
    sup.onStdout = args.onStdout
    sup.onExit = args.onExit
    sup.onSpawnError = args.onSpawnError
    sup.launch = args.launch
    return sup
  }
  return { sup, factory }
}

const noopLogger = { error: () => {}, warn: mock(() => {}), info: () => {}, banner: mock(() => {}) }

const start = (over = {}) => {
  const { FakeWss, getOpts } = makeFakeWss()
  const { sup, factory } = makeFakeSupervisor()
  const logger = {
    error: () => {},
    info: () => {},
    warn: mock(() => {}),
    banner: mock(() => {}),
  }
  const promise = startBridge({
    launch: ['node', 'agent.js'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger,
    deps: { WebSocketServer: FakeWss, superviseChild: factory },
    ...over,
  })
  // The promise resolves on 'listening'; expose the wss to drive it.
  return { promise, getOpts, sup, logger, FakeWss }
}

test('binds on 127.0.0.1 and resolves url ws://127.0.0.1:PORT, calling logger.banner once', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { factory } = makeFakeSupervisor()
  const logger = { error: () => {}, info: () => {}, warn: () => {}, banner: mock(() => {}) }
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  const face = await p
  expect(face.url).toBe('ws://127.0.0.1:5123')
  expect(logger.banner).toHaveBeenCalledTimes(1)
  expect(logger.banner).toHaveBeenCalledWith('ws://127.0.0.1:5123')
})

test('a listen EADDRINUSE rejects with an unavailable error and SIGKILLs the child first', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))
  await expect(p).rejects.toMatchObject({ name: 'UnavailableError', code: 'EADDRINUSE' })
  expect(sup.kill).toHaveBeenCalledTimes(1)
})

test('Origin gate rejects a disallowed Origin and accepts a loopback/undefined Origin', async () => {
  const { getOpts, promise } = start()
  const verifyClient = getOpts().verifyClient
  expect(verifyClient({ origin: 'http://evil.com' })).toBe(false)
  expect(verifyClient({ origin: 'http://localhost:3000' })).toBe(true)
  expect(verifyClient({ origin: undefined })).toBe(true)
  // resolve the dangling promise
  getOpts() // noop; clean up by emitting listening through a fresh handle below
  await Promise.resolve()
})

test('--allow-any-origin accepts any Origin (gate disabled)', async () => {
  const { getOpts } = start({ allowAnyOrigin: true })
  expect(getOpts().verifyClient({ origin: 'http://evil.com' })).toBe(true)
})

test('newest-wins: a second connection closes the first with 1000 and becomes sole pump', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  await p
  const first = makeFakeWs()
  const second = makeFakeWs()
  wssRef.emit('connection', first)
  wssRef.emit('connection', second)
  expect(first.close).toHaveBeenCalledWith(CLOSE_NORMAL)
  // The newest socket pumps to the child.
  second.emit('message', '{"jsonrpc":"2.0","method":"ping","id":1}')
  expect(sup.writeStdin).toHaveBeenCalledTimes(1)
})

test('supersession physically resumes child stdout the prior client had paused (no wedge)', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  await p
  // First client congests: its send keeps bufferedAmount above HIGH_WATER so the
  // pause branch fires and never resumes (we hold the send callbacks pending).
  const first = makeFakeWs()
  first.bufferedAmount = HIGH_WATER + 1
  first.send = mock(() => {}) // callback never invoked -> stays paused
  wssRef.emit('connection', first)
  sup.onStdout(Buffer.from('{"a":1}\n'))
  expect(sup.pauseStdout).toHaveBeenCalledTimes(1)
  expect(sup.resumeStdout).not.toHaveBeenCalled()
  // A new client supersedes the wedged one; it must physically resume stdout.
  const second = makeFakeWs()
  wssRef.emit('connection', second)
  expect(first.close).toHaveBeenCalledWith(CLOSE_NORMAL)
  expect(sup.resumeStdout).toHaveBeenCalledTimes(1)
  // child output now flows to the new client (not wedged behind the old pause).
  sup.onStdout(Buffer.from('{"b":2}\n'))
  expect(second.send).toHaveBeenCalledTimes(1)
  expect(second.send.mock.calls[0][0]).toBe('{"b":2}')
})

test('child stdout NDJSON line is frameToWs-d and sent to the live client (no trailing newline)', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  await p
  const ws = makeFakeWs()
  wssRef.emit('connection', ws)
  sup.onStdout(Buffer.from('{"jsonrpc":"2.0","result":1,"id":2}\n'))
  expect(ws.send).toHaveBeenCalledTimes(1)
  expect(ws.send.mock.calls[0][0]).toBe('{"jsonrpc":"2.0","result":1,"id":2}')
})

test('inbound WS message is wsToFrame-d and written to child stdin with a trailing newline', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  await p
  const ws = makeFakeWs()
  wssRef.emit('connection', ws)
  ws.emit('message', '{"jsonrpc":"2.0","method":"m","id":3}')
  expect(sup.writeStdin).toHaveBeenCalledWith('{"jsonrpc":"2.0","method":"m","id":3}\n')
})

test('backpressure: high ws.bufferedAmount pauses child stdout; drain resumes it', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  await p
  // send callback deferred so we control when 'flush' (resume check) fires.
  const pending = []
  const ws = makeFakeWs()
  ws.bufferedAmount = HIGH_WATER + 1
  ws.send = mock((_data, cb) => pending.push(cb))
  wssRef.emit('connection', ws)
  sup.onStdout(Buffer.from('{"a":1}\n'))
  expect(sup.pauseStdout).toHaveBeenCalledTimes(1)
  // drain below low-water then fire the send callback => resume.
  ws.bufferedAmount = LOW_WATER - 1
  pending.forEach((cb) => cb())
  expect(sup.resumeStdout).toHaveBeenCalledTimes(1)
})

test('backpressure: writeStdin returning false pauses WS reading until drain', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  sup.writeStdin = mock(() => false)
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  await p
  const ws = makeFakeWs()
  wssRef.emit('connection', ws)
  ws.emit('message', '{"jsonrpc":"2.0","method":"m","id":1}')
  expect(ws.pause).toHaveBeenCalledTimes(1)
  sup.child.stdin.emit('drain')
  expect(ws.resume).toHaveBeenCalledTimes(1)
})

test('a malformed frame (either direction) is dropped and logged by method/id only, not fatal', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const logger = { error: () => {}, info: () => {}, warn: mock(() => {}), banner: () => {} }
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  await p
  const ws = makeFakeWs()
  wssRef.emit('connection', ws)
  // malformed inbound: not JSON
  ws.emit('message', 'not json {{{')
  expect(sup.writeStdin).not.toHaveBeenCalled()
  // malformed child line dropped (no send)
  sup.onStdout(Buffer.from('still not json{{{\n'))
  expect(ws.send).not.toHaveBeenCalled()
  // logged, and never the raw body
  const loggedBodies = logger.warn.mock.calls.flat().map((a) => JSON.stringify(a))
  expect(loggedBodies.some((s) => s.includes('not json'))).toBe(false)
  expect(logger.warn).toHaveBeenCalled()
})

test('child exit closes the server + client(1000) and resolves close()', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const onChildExit = mock(() => {})
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    onChildExit,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  const face = await p
  const ws = makeFakeWs()
  wssRef.emit('connection', ws)
  sup.onExit({ code: 0, signal: null })
  expect(ws.close).toHaveBeenCalledWith(CLOSE_NORMAL)
  expect(wssRef.closed).toBe(true)
  expect(onChildExit).toHaveBeenCalledWith({ code: 0, signal: null })
  // close() resolves even after the child already exited.
  await face.close()
})

test('the resolved face exposes kill() which immediately SIGKILLs the child', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  const face = await p
  expect(typeof face.kill).toBe('function')
  face.kill()
  expect(sup.kill).toHaveBeenCalledTimes(1)
})

test('close() closes sockets, closes the server, and stops the child (grace->SIGKILL)', async () => {
  let wssRef
  const { FakeWss } = makeFakeWss()
  class Capture extends FakeWss {
    constructor(o) {
      super(o)
      wssRef = this
    }
  }
  const { sup, factory } = makeFakeSupervisor()
  const p = startBridge({
    launch: ['x'],
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    logger: noopLogger,
    deps: { WebSocketServer: Capture, superviseChild: factory },
  })
  wssRef.emit('listening')
  const face = await p
  const ws = makeFakeWs()
  wssRef.emit('connection', ws)
  await face.close()
  expect(ws.close).toHaveBeenCalledWith(CLOSE_NORMAL)
  expect(sup.stop).toHaveBeenCalledTimes(1)
  expect(wssRef.closed).toBe(true)
})
