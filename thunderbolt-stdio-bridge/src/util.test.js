/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const { test, expect } = require('bun:test')
const { resolvePort, formatHostForUrl, isLoopbackHost, insecureFlagWarnings } = require('./util')
const { UsageError } = require('./errors')

test('resolvePort: undefined→0, ""→0, "0"→0, "8080"→8080', () => {
  expect(resolvePort(undefined)).toBe(0)
  expect(resolvePort('')).toBe(0)
  expect(resolvePort('0')).toBe(0)
  expect(resolvePort('8080')).toBe(8080)
  expect(resolvePort(8080)).toBe(8080)
})

test('resolvePort: out-of-range / non-integer each throw UsageError', () => {
  expect(() => resolvePort('70000')).toThrow(UsageError)
  expect(() => resolvePort('abc')).toThrow(UsageError)
  expect(() => resolvePort('-1')).toThrow(UsageError)
  expect(() => resolvePort('3000.5')).toThrow(UsageError)
})

test('formatHostForUrl wraps ::1 in brackets and is idempotent on [::1]', () => {
  expect(formatHostForUrl('::1')).toBe('[::1]')
  expect(formatHostForUrl('[::1]')).toBe('[::1]')
})

test('formatHostForUrl passes 127.0.0.1 and hostnames through unchanged', () => {
  expect(formatHostForUrl('127.0.0.1')).toBe('127.0.0.1')
  expect(formatHostForUrl('localhost')).toBe('localhost')
  expect(formatHostForUrl('example.com')).toBe('example.com')
})

test('isLoopbackHost true for 127.0.0.1, 127.0.0.2, ::1, [::1], LOCALHOST', () => {
  expect(isLoopbackHost('127.0.0.1')).toBe(true)
  expect(isLoopbackHost('127.0.0.2')).toBe(true)
  expect(isLoopbackHost('::1')).toBe(true)
  expect(isLoopbackHost('[::1]')).toBe(true)
  expect(isLoopbackHost('LOCALHOST')).toBe(true)
})

test('isLoopbackHost false for 0.0.0.0, 192.168.1.5, example.com', () => {
  expect(isLoopbackHost('0.0.0.0')).toBe(false)
  expect(isLoopbackHost('192.168.1.5')).toBe(false)
  expect(isLoopbackHost('example.com')).toBe(false)
  expect(isLoopbackHost('127.0.0.256')).toBe(false)
})

test('insecureFlagWarnings empty for a safe loopback config', () => {
  expect(insecureFlagWarnings({ host: '127.0.0.1', allowAnyOrigin: false, tunnel: false })).toEqual([])
})

test('insecureFlagWarnings has one line for allowAnyOrigin on a loopback host', () => {
  const warnings = insecureFlagWarnings({ host: '127.0.0.1', allowAnyOrigin: true, tunnel: false })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('--allow-any-origin')
})

test('insecureFlagWarnings has an EXTRA loud DANGER line for allowAnyOrigin + non-loopback host', () => {
  const warnings = insecureFlagWarnings({ host: '0.0.0.0', allowAnyOrigin: true, tunnel: false })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('DANGER')
  expect(warnings[0]).toContain('0.0.0.0')
})

test('insecureFlagWarnings notes public exposure when tunnel:true', () => {
  const warnings = insecureFlagWarnings({ host: '127.0.0.1', allowAnyOrigin: false, tunnel: true })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('--tunnel')
})

test('insecureFlagWarnings returns strings and performs no I/O', () => {
  const warnings = insecureFlagWarnings({ host: '0.0.0.0', allowAnyOrigin: true, tunnel: true })
  expect(warnings).toHaveLength(2)
  expect(warnings.every((w) => typeof w === 'string')).toBe(true)
})
