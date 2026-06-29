/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from 'bun:test'
import { createNdjsonReader, frameToWs, wsToFrame, MalformedFrameError, parseFrame } from './relay'

const collect = () => {
  const lines: string[] = []
  const reader = createNdjsonReader((line) => lines.push(line))
  return { lines, reader }
}

test('a single complete line emits one onLine without the trailing newline', () => {
  const { lines, reader } = collect()
  reader.push('{"a":1}\n')
  expect(lines).toEqual(['{"a":1}'])
})

test('a JSON object split across two push() calls emits exactly once when completed', () => {
  const { lines, reader } = collect()
  reader.push('{"a":')
  expect(lines).toEqual([])
  reader.push('1}\n')
  expect(lines).toEqual(['{"a":1}'])
})

test('multiple newline-separated lines in one chunk emit in order', () => {
  const { lines, reader } = collect()
  reader.push('{"a":1}\n{"b":2}\n{"c":3}\n')
  expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
})

test('\\r\\n endings are normalized to a clean line', () => {
  const { lines, reader } = collect()
  reader.push('{"a":1}\r\n')
  expect(lines).toEqual(['{"a":1}'])
})

test('empty / whitespace-only lines are skipped (no emit)', () => {
  const { lines, reader } = collect()
  reader.push('\n  \n{"a":1}\n\n')
  expect(lines).toEqual(['{"a":1}'])
})

test('flush() emits a trailing unterminated line; flush() on empty buffer emits nothing', () => {
  const { lines, reader } = collect()
  reader.push('{"a":1}')
  expect(lines).toEqual([])
  reader.flush()
  expect(lines).toEqual(['{"a":1}'])
  reader.flush()
  expect(lines).toEqual(['{"a":1}'])
})

test('accepts a Buffer chunk', () => {
  const { lines, reader } = collect()
  reader.push(Buffer.from('{"a":1}\n', 'utf8'))
  expect(lines).toEqual(['{"a":1}'])
})

test('frameToWs returns the JSON object string with NO trailing newline', () => {
  expect(frameToWs('{"a":1}')).toBe('{"a":1}')
})

test('wsToFrame appends exactly one trailing newline', () => {
  expect(wsToFrame('{"a":1}')).toBe('{"a":1}\n')
})

test('frameToWs and wsToFrame throw MalformedFrameError on non-JSON input', () => {
  expect(() => frameToWs('not json')).toThrow(MalformedFrameError)
  expect(() => wsToFrame('not json')).toThrow(MalformedFrameError)
})

test('parseFrame returns the parsed object on valid JSON and throws MalformedFrameError otherwise', () => {
  expect(parseFrame('{"method":"x"}')).toEqual({ method: 'x' })
  expect(() => parseFrame('{bad')).toThrow(MalformedFrameError)
})

test('round-trip: wsToFrame then createNdjsonReader yields the original object string', () => {
  const original = '{"jsonrpc":"2.0","method":"initialize","id":1}'
  const { lines, reader } = collect()
  reader.push(wsToFrame(original))
  expect(lines).toEqual([original])
  expect(frameToWs(lines[0])).toBe(original)
})
