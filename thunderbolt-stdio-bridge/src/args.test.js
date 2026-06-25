/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const { test, expect } = require('bun:test')
const { parseArgs } = require('./args')
const { UsageError } = require('./errors')

test('--mode acp -- node agent.js → mode acp, launch=[node, agent.js]', () => {
  const parsed = parseArgs(['--mode', 'acp', '--', 'node', 'agent.js'])
  expect(parsed.mode).toBe('acp')
  expect(parsed.launch).toEqual(['node', 'agent.js'])
})

test('--mode mcp --tunnel -- srv → tunnel true', () => {
  expect(parseArgs(['--mode', 'mcp', '--tunnel', '--', 'srv']).tunnel).toBe(true)
})

test('--tunnel --mode acp -- x → UsageError (tunnel requires mcp)', () => {
  expect(() => parseArgs(['--tunnel', '--mode', 'acp', '--', 'x'])).toThrow(UsageError)
})

test('missing --mode → UsageError', () => {
  expect(() => parseArgs(['--', 'node', 'x.js'])).toThrow(UsageError)
})

test('--mode bogus → UsageError', () => {
  expect(() => parseArgs(['--mode', 'bogus', '--', 'x'])).toThrow(UsageError)
})

test('no `--` delimiter → UsageError (empty launch)', () => {
  expect(() => parseArgs(['--mode', 'acp'])).toThrow(UsageError)
})

test('`--` with nothing after → UsageError', () => {
  expect(() => parseArgs(['--mode', 'acp', '--'])).toThrow(UsageError)
})

test('repeated --allow-origin a --allow-origin b → allowOrigins=[a,b]', () => {
  const parsed = parseArgs(['--mode', 'acp', '--allow-origin', 'a', '--allow-origin', 'b', '--', 'x'])
  expect(parsed.allowOrigins).toEqual(['a', 'b'])
})

test('--allow-any-origin sets the flag true', () => {
  expect(parseArgs(['--mode', 'acp', '--allow-any-origin', '--', 'x']).allowAnyOrigin).toBe(true)
})

test('--port 8080 parses to 8080; --port 70000 / --port abc → UsageError', () => {
  expect(parseArgs(['--mode', 'acp', '--port', '8080', '--', 'x']).port).toBe(8080)
  expect(() => parseArgs(['--mode', 'acp', '--port', '70000', '--', 'x'])).toThrow(UsageError)
  expect(() => parseArgs(['--mode', 'acp', '--port', 'abc', '--', 'x'])).toThrow(UsageError)
})

test('--host 0.0.0.0 retained verbatim', () => {
  expect(parseArgs(['--mode', 'acp', '--host', '0.0.0.0', '--', 'x']).host).toBe('0.0.0.0')
})

test('--help returns {help:true} ignoring other flags; --version returns {version:true}', () => {
  expect(parseArgs(['--mode', 'bogus', '--help'])).toEqual({ help: true })
  expect(parseArgs(['--version'])).toEqual({ version: true })
})

test('-h and -V short aliases work', () => {
  expect(parseArgs(['-h'])).toEqual({ help: true })
  expect(parseArgs(['-V'])).toEqual({ version: true })
})

test('everything after the first `--` is preserved verbatim including further `--` and dashes', () => {
  const parsed = parseArgs(['--mode', 'mcp', '--', 'npx', 'srv', '--', '--flag', '-x'])
  expect(parsed.launch).toEqual(['npx', 'srv', '--', '--flag', '-x'])
})

test('unknown --frob → UsageError', () => {
  expect(() => parseArgs(['--mode', 'acp', '--frob', '--', 'x'])).toThrow(UsageError)
})

test('--json and --verbose toggle their booleans; defaults are false', () => {
  const on = parseArgs(['--mode', 'acp', '--json', '--verbose', '--', 'x'])
  expect(on.json).toBe(true)
  expect(on.verbose).toBe(true)
  const off = parseArgs(['--mode', 'acp', '--', 'x'])
  expect(off.json).toBe(false)
  expect(off.verbose).toBe(false)
})

test('default host=127.0.0.1 and port=0 when omitted', () => {
  const parsed = parseArgs(['--mode', 'acp', '--', 'x'])
  expect(parsed.host).toBe('127.0.0.1')
  expect(parsed.port).toBe(0)
})

test('flag expecting a value at end-of-argv → UsageError', () => {
  expect(() => parseArgs(['--mode'])).toThrow(UsageError)
})

test('a flag value that itself looks like a flag is treated as a missing value → UsageError', () => {
  expect(() => parseArgs(['--host', '--port', '--', 'x'])).toThrow(UsageError)
})

test('flags may appear in any order before `--`', () => {
  const parsed = parseArgs(['--verbose', '--port', '3000', '--mode', 'mcp', '--json', '--', 'srv'])
  expect(parsed.mode).toBe('mcp')
  expect(parsed.port).toBe(3000)
  expect(parsed.verbose).toBe(true)
  expect(parsed.json).toBe(true)
})
