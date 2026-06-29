/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from 'bun:test'
import { EX, UsageError, UnavailableError, SigintError, toExitCode, toMessage, childExitToCode } from './errors'

test('EX table values are exactly {0,64,69,70,130}', () => {
  expect(EX).toEqual({ OK: 0, USAGE: 64, UNAVAILABLE: 69, SOFTWARE: 70, SIGINT: 130 })
})

test('toExitCode(UsageError) === 64', () => {
  expect(toExitCode(new UsageError('--mode is required'))).toBe(64)
})

test('toExitCode(UnavailableError EADDRINUSE) === 69', () => {
  expect(toExitCode(new UnavailableError({ code: 'EADDRINUSE' }))).toBe(69)
})

test('toExitCode of a plain Error with code ENOENT === 69', () => {
  const err = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
  expect(toExitCode(err)).toBe(69)
})

test('toExitCode of an unknown Error === 70', () => {
  expect(toExitCode(new Error('boom'))).toBe(70)
})

test('toExitCode of a SIGINT marker === 130', () => {
  expect(toExitCode(new SigintError())).toBe(130)
})

test('toExitCode of a thrown string === 70', () => {
  expect(toExitCode('not an error')).toBe(70)
})

test('toMessage(UsageError) names the flag and no payload', () => {
  const msg = toMessage(new UsageError('unknown flag --frob'))
  expect(msg).toBe('unknown flag --frob')
})

test('toMessage of an ENOENT error says "command not found" with no err.message/path', () => {
  const err = Object.assign(new Error('spawn /usr/secret/path ENOENT'), { code: 'ENOENT', path: '/usr/secret/path' })
  const msg = toMessage(err)
  expect(msg).toBe('command not found')
  expect(msg).not.toContain('/usr/secret/path')
  expect(msg).not.toContain('spawn')
})

test('toMessage of an arbitrary Error contains only a generic phrase + errorCode, never the message text', () => {
  const err = Object.assign(new Error('secret payload data 12345'), { code: 'EWEIRD' })
  const msg = toMessage(err)
  expect(msg).toBe('internal error (EWEIRD)')
  expect(msg).not.toContain('secret payload data')
})

test('toMessage of a codeless arbitrary Error is a fixed generic phrase', () => {
  expect(toMessage(new Error('leak me'))).toBe('internal error')
  expect(toMessage('a thrown string')).toBe('internal error')
})

test('toMessage of UnavailableError maps each unavailable code to a fixed phrase', () => {
  expect(toMessage(new UnavailableError({ code: 'EADDRINUSE' }))).toBe('address in use')
  expect(toMessage(new UnavailableError({ code: 'EACCES' }))).toBe('permission denied')
})

test('childExitToCode({code:0}) === 0', () => {
  expect(childExitToCode({ code: 0, signal: null })).toBe(0)
})

test('childExitToCode({code:1}) === 70', () => {
  expect(childExitToCode({ code: 1, signal: null })).toBe(70)
})

test('childExitToCode({signal:SIGINT}) === 130', () => {
  expect(childExitToCode({ code: null, signal: 'SIGINT' })).toBe(130)
})

test('childExitToCode for a non-SIGINT signal === 70', () => {
  expect(childExitToCode({ code: null, signal: 'SIGTERM' })).toBe(70)
})
