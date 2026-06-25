// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

'use strict'

const { test, expect, mock } = require('bun:test')
const { EventEmitter } = require('node:events')
const { superviseChild } = require('./child')

/** Minimal fake ChildProcess: EventEmitter with controllable stdin/stdout. */
const makeFakeChild = () => {
  const child = new EventEmitter()
  child.killed = false
  child.kill = mock((signal) => {
    child.killed = true
    child.lastSignal = signal
    return true
  })
  child.stdin = {
    destroyed: false,
    writableEnded: false,
    write: mock(() => true),
  }
  child.stdout = new EventEmitter()
  child.stdout.pause = mock(() => {})
  child.stdout.resume = mock(() => {})
  return child
}

const noopLogger = { error: () => {}, warn: () => {}, info: () => {}, banner: () => {} }

const baseOpts = (child, overrides = {}) => ({
  launch: ['node', 'agent.js'],
  spawn: mock(() => child),
  onStdout: () => {},
  onExit: () => {},
  onSpawnError: () => {},
  logger: noopLogger,
  ...overrides,
})

test('spawns exactly once with launch[0] + args and stdio pipe/pipe/inherit', () => {
  const child = makeFakeChild()
  const spawn = mock(() => child)
  superviseChild(baseOpts(child, { spawn }))
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn.mock.calls[0][0]).toBe('node')
  expect(spawn.mock.calls[0][1]).toEqual(['agent.js'])
  expect(spawn.mock.calls[0][2]).toEqual({ stdio: ['pipe', 'pipe', 'inherit'] })
})

test('child stdout data is forwarded to onStdout', () => {
  const child = makeFakeChild()
  const onStdout = mock(() => {})
  superviseChild(baseOpts(child, { onStdout }))
  const chunk = Buffer.from('hello')
  child.stdout.emit('data', chunk)
  expect(onStdout).toHaveBeenCalledTimes(1)
  expect(onStdout.mock.calls[0][0]).toBe(chunk)
})

test('child exit fires onExit exactly once with {code,signal} and marks not-alive', () => {
  const child = makeFakeChild()
  const onExit = mock(() => {})
  const s = superviseChild(baseOpts(child, { onExit }))
  expect(s.alive()).toBe(true)
  child.emit('exit', 0, null)
  child.emit('exit', 0, null) // second exit ignored
  expect(onExit).toHaveBeenCalledTimes(1)
  expect(onExit.mock.calls[0][0]).toEqual({ code: 0, signal: null })
  expect(s.alive()).toBe(false)
})

test('a spawn error (ENOENT) calls onSpawnError and never onExit-as-success', () => {
  const child = makeFakeChild()
  const onSpawnError = mock(() => {})
  const onExit = mock(() => {})
  const s = superviseChild(baseOpts(child, { onSpawnError, onExit }))
  const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
  child.emit('error', err)
  expect(onSpawnError).toHaveBeenCalledTimes(1)
  expect(onSpawnError.mock.calls[0][0]).toBe(err)
  expect(onExit).not.toHaveBeenCalled()
  expect(s.alive()).toBe(false)
})

test('writeStdin returns the underlying write boolean (false signals backpressure)', () => {
  const child = makeFakeChild()
  child.stdin.write = mock(() => false)
  const s = superviseChild(baseOpts(child))
  expect(s.writeStdin('x')).toBe(false)
  expect(child.stdin.write).toHaveBeenCalledTimes(1)
})

test('writeStdin after the child exits is a safe no-op returning true', () => {
  const child = makeFakeChild()
  const s = superviseChild(baseOpts(child))
  child.emit('exit', 0, null)
  child.stdin.write = mock(() => false)
  expect(s.writeStdin('x')).toBe(true)
  expect(child.stdin.write).not.toHaveBeenCalled()
})

test('pauseStdout/resumeStdout pause and resume the child stdout stream', () => {
  const child = makeFakeChild()
  const s = superviseChild(baseOpts(child))
  s.pauseStdout()
  s.resumeStdout()
  expect(child.stdout.pause).toHaveBeenCalledTimes(1)
  expect(child.stdout.resume).toHaveBeenCalledTimes(1)
})

test('stop() sends SIGTERM then SIGKILLs after the grace window if still alive', async () => {
  const child = makeFakeChild()
  const s = superviseChild(baseOpts(child, { graceMs: 10 }))
  s.stop()
  expect(child.kill).toHaveBeenLastCalledWith('SIGTERM')
  await new Promise((r) => setTimeout(r, 25))
  expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
})

test('stop() does NOT SIGKILL if the child exits within the grace window', async () => {
  const child = makeFakeChild()
  const s = superviseChild(baseOpts(child, { graceMs: 50 }))
  s.stop()
  child.emit('exit', 0, 'SIGTERM') // child obeyed
  await new Promise((r) => setTimeout(r, 70))
  const sigkills = child.kill.mock.calls.filter((c) => c[0] === 'SIGKILL')
  expect(sigkills.length).toBe(0)
})

test('kill() sends SIGKILL immediately and is idempotent', () => {
  const child = makeFakeChild()
  const s = superviseChild(baseOpts(child))
  s.kill()
  expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
  const callsAfterFirst = child.kill.mock.calls.length
  child.emit('exit', null, 'SIGKILL')
  s.kill() // no-op after exit
  expect(child.kill.mock.calls.length).toBe(callsAfterFirst)
})

test('NEVER respawns: a second exit does not trigger a new spawn', () => {
  const child = makeFakeChild()
  const spawn = mock(() => child)
  superviseChild(baseOpts(child, { spawn }))
  child.emit('exit', 0, null)
  child.emit('exit', 1, null)
  expect(spawn).toHaveBeenCalledTimes(1)
})

test('stop()/kill() after exit are no-ops', () => {
  const child = makeFakeChild()
  const s = superviseChild(baseOpts(child))
  child.emit('exit', 0, null)
  const before = child.kill.mock.calls.length
  s.stop()
  s.kill()
  expect(child.kill.mock.calls.length).toBe(before)
})
