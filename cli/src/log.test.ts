/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from 'bun:test'
import { makeLogger, buildOriginAllowlist, classifyMethod, classifyId, classifyFrame, safeClassifyFrame } from './log'
import type { LogFields } from './types'

/** A fake writable sink that records every written line. */
type RecordingSink = NodeJS.WritableStream & { lines: string[] }

const makeSink = (): RecordingSink => {
  const lines: string[] = []
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  } as unknown as RecordingSink
}

test('json mode emits one parseable JSON object per call with event + allowlisted scalars only', () => {
  const sink = makeSink()
  const logger = makeLogger({ json: true, verbose: true, sink })
  logger.info('frame', { method: 'initialize', id: 'request', port: 5000 })
  expect(sink.lines).toHaveLength(1)
  const parsed = JSON.parse(sink.lines[0])
  expect(parsed).toEqual({ level: 'info', event: 'frame', method: 'initialize', id: 'request', port: 5000 })
})

test('text mode emits a single human line; verbose=false suppresses info but keeps warn/error', () => {
  const sink = makeSink()
  const logger = makeLogger({ json: false, verbose: false, sink })
  logger.info('skipped', { method: 'tools/list' })
  expect(sink.lines).toHaveLength(0)
  logger.warn('insecure', { host: '0.0.0.0' })
  logger.error('failed', { errorCode: 'EADDRINUSE' })
  expect(sink.lines).toHaveLength(2)
  expect(sink.lines[0]).toBe('[warn] insecure host=0.0.0.0\n')
  expect(sink.lines[1]).toBe('[error] failed errorCode=EADDRINUSE\n')
})

test('a fields object with a nested object or non-allowlisted key is stripped before output', () => {
  const sink = makeSink()
  const logger = makeLogger({ json: true, verbose: true, sink })
  logger.info('frame', {
    method: 'x',
    params: { secret: 'leak' },
    nested: { a: 1 },
    password: 'hunter2',
  } as unknown as LogFields)
  const parsed = JSON.parse(sink.lines[0])
  expect(parsed).toEqual({ level: 'info', event: 'frame', method: 'x' })
  expect(sink.lines[0]).not.toContain('leak')
  expect(sink.lines[0]).not.toContain('hunter2')
})

test('logger writes only to the injected sink', () => {
  const sink = makeSink()
  const logger = makeLogger({ json: false, verbose: true, sink })
  logger.warn('w')
  expect(sink.lines).toHaveLength(1)
})

test('banner prints the url (text) and {event:listening,url} (json) for ws', () => {
  const textSink = makeSink()
  makeLogger({ json: false, verbose: false, sink: textSink }).banner('ws://127.0.0.1:5000')
  expect(textSink.lines[0]).toBe('ws://127.0.0.1:5000\n')

  const jsonSink = makeSink()
  makeLogger({ json: true, verbose: false, sink: jsonSink }).banner('ws://127.0.0.1:5000')
  expect(JSON.parse(jsonSink.lines[0])).toEqual({ event: 'listening', url: 'ws://127.0.0.1:5000' })
})

test('banner for mcp prints {event:mcp-listening,url} in json', () => {
  const sink = makeSink()
  makeLogger({ json: true, verbose: false, sink }).banner('http://127.0.0.1:5000/mcp')
  expect(JSON.parse(sink.lines[0])).toEqual({ event: 'mcp-listening', url: 'http://127.0.0.1:5000/mcp' })
})

test('buildOriginAllowlist with allowAnyOrigin returns true for any origin including evil.com', () => {
  const allow = buildOriginAllowlist({ allowOrigins: [], allowAnyOrigin: true })
  expect(allow('http://evil.com')).toBe(true)
  expect(allow(undefined)).toBe(true)
})

test('default allowlist accepts undefined Origin and loopback origins', () => {
  const allow = buildOriginAllowlist({ allowOrigins: [], allowAnyOrigin: false })
  expect(allow(undefined)).toBe(true)
  expect(allow('')).toBe(true)
  expect(allow('http://localhost:3000')).toBe(true)
  expect(allow('http://127.0.0.1:5173')).toBe(true)
  expect(allow('http://[::1]:8080')).toBe(true)
})

test('default allowlist rejects http://evil.com and malformed origins', () => {
  const allow = buildOriginAllowlist({ allowOrigins: [], allowAnyOrigin: false })
  expect(allow('http://evil.com')).toBe(false)
  expect(allow('not a url')).toBe(false)
})

test('an explicit --allow-origin entry matches regardless of trailing path/slash', () => {
  const allow = buildOriginAllowlist({ allowOrigins: ['https://app.example.com/'], allowAnyOrigin: false })
  expect(allow('https://app.example.com')).toBe(true)
  expect(allow('https://app.example.com/some/path')).toBe(true)
  expect(allow('https://other.example.com')).toBe(false)
})

test('classifyMethod returns the method name and never params/result', () => {
  expect(classifyMethod({ jsonrpc: '2.0', method: 'tools/call', params: { secret: 'x' } })).toBe('tools/call')
})

test('classifyMethod of a frame without method → unknown', () => {
  expect(classifyMethod({ id: 1, result: { data: 'x' } })).toBe('unknown')
  expect(classifyMethod(null)).toBe('unknown')
  expect(classifyMethod('string')).toBe('unknown')
})

test('classifyId distinguishes request/response/notification/absent without leaking the id value', () => {
  expect(classifyId({ id: 42, method: 'initialize' })).toBe('request')
  expect(classifyId({ id: 42, result: {} })).toBe('response')
  expect(classifyId({ method: 'notifications/progress' })).toBe('notification')
  expect(classifyId({})).toBe('absent')
})

test('classifyFrame(null) → the inert no-leak fallback shape', () => {
  expect(classifyFrame(null)).toEqual({ method: 'unknown', id: 'absent' })
})

test('safeClassifyFrame: a bad-JSON raw string → the inert { method: unknown, id: absent } fallback', () => {
  expect(safeClassifyFrame('{bad json')).toEqual({ method: 'unknown', id: 'absent' })
})

test('safeClassifyFrame: a well-formed request frame → { method, id: request } and never the id value', () => {
  expect(safeClassifyFrame('{"method":"x","id":1}')).toEqual({ method: 'x', id: 'request' })
})

test('error() logs the passed errorCode and never a message/stack string', () => {
  const sink = makeSink()
  const logger = makeLogger({ json: true, verbose: false, sink })
  logger.error('child-spawn', { errorCode: 'ENOENT' })
  const parsed = JSON.parse(sink.lines[0])
  expect(parsed.errorCode).toBe('ENOENT')
  expect(sink.lines[0]).not.toContain('stack')
})
