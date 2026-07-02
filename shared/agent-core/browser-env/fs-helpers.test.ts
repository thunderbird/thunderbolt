/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the ZenFS<->Pi interop helpers. These are pure functions, so
 * they are tested directly (no mount needed). The error-code mapping is
 * security-relevant: it is what turns a ZenFS `EACCES`/`EPERM` (raised when the
 * jail or backend denies access) into Pi's `permission_denied`, and a missing
 * file into `not_found` — the code the coding tools branch on to decide
 * create-vs-edit. A regression here would silently mis-classify denials.
 */

import { describe, expect, it } from 'bun:test'
import { FileError } from '@earendil-works/pi-agent-core'
import { abortedResult, fileInfoFrom, splitLines, toFileError, type ZenStats } from './fs-helpers.ts'

const errno = (code: string, message = code): Error & { code: string } =>
  Object.assign(new Error(message), { code })

const statOf = (kind: 'file' | 'dir' | 'symlink' | 'other', over: Partial<ZenStats> = {}): ZenStats => ({
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => kind === 'symlink',
  mode: 0o644,
  size: 0,
  mtime: new Date(0),
  mtimeMs: 0,
  ...over,
})

describe('toFileError', () => {
  it('returns an existing FileError unchanged (passthrough, no double-wrap)', () => {
    const original = new FileError('is_directory', 'orig', '/p')
    expect(toFileError(original, '/other')).toBe(original)
  })

  it.each([
    ['ABORT_ERR', 'aborted'],
    ['ENOENT', 'not_found'],
    ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'],
    ['ENOTDIR', 'not_directory'],
    ['EISDIR', 'is_directory'],
    ['EINVAL', 'invalid'],
  ] as const)('maps errno %s -> %s', (code, expectedCode) => {
    const thrown = errno(code, `${code} boom`)
    const result = toFileError(thrown, '/x')
    expect(result).toBeInstanceOf(FileError)
    expect(result.code).toBe(expectedCode)
    expect(result.message).toBe(`${code} boom`)
    expect(result.path).toBe('/x')
    // The exact original error is preserved as the cause (not a rewrapped copy).
    expect((result as { cause?: Error }).cause).toBe(thrown)
  })

  it('falls back to "unknown" for an unrecognized errno code', () => {
    const result = toFileError(errno('EEXIST', 'already there'), '/x')
    expect(result.code).toBe('unknown')
    expect(result.message).toBe('already there')
  })

  it('treats an Error whose `code` is non-string as unknown (errno codes are strings)', () => {
    // A numeric `code` (some libraries use numbers) must not be matched against
    // the string switch — `isErrnoError` requires `typeof code === 'string'`.
    const result = toFileError(Object.assign(new Error('numeric code'), { code: 123 }), '/x')
    expect(result.code).toBe('unknown')
    expect(result.message).toBe('numeric code')
  })

  it('treats a non-Error value carrying a string `code` as unknown (only real errno Errors map)', () => {
    // Security: a plain object {code:'ENOENT'} must NOT be mapped to not_found.
    // Only genuine thrown Errors get the specific mapping; otherwise an attacker
    // controlling a thrown payload could forge a benign code.
    const result = toFileError({ code: 'ENOENT', message: 'fake' }, '/x')
    expect(result.code).toBe('unknown')
  })

  it('maps a plain Error with no `code` to unknown, carrying its message', () => {
    const result = toFileError(new Error('plain failure'), '/x')
    expect(result.code).toBe('unknown')
    expect(result.message).toBe('plain failure')
  })

  it('coerces a thrown non-Error (string) into an unknown FileError', () => {
    const result = toFileError('just a string', '/x')
    expect(result.code).toBe('unknown')
    expect(result.message).toBe('just a string')
  })
})

describe('fileInfoFrom', () => {
  it('builds a file info with basename, size and mtimeMs', () => {
    const result = fileInfoFrom('/workspace/t1/mine.txt', statOf('file', { size: 42, mtimeMs: 1234 }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value).toEqual({ name: 'mine.txt', path: '/workspace/t1/mine.txt', kind: 'file', size: 42, mtimeMs: 1234 })
  })

  it.each([
    ['dir', 'directory'],
    ['symlink', 'symlink'],
  ] as const)('classifies %s stats as kind %s', (statKind, expectedKind) => {
    const result = fileInfoFrom('/workspace/x', statOf(statKind))
    expect(result.ok && result.value.kind).toBe(expectedKind)
  })

  it('falls back to the path when basename is empty (root "/")', () => {
    const result = fileInfoFrom('/', statOf('dir'))
    expect(result.ok && result.value.name).toBe('/')
  })

  it('returns an invalid FileError for a kind Pi does not model (e.g. device/fifo)', () => {
    const result = fileInfoFrom('/dev/null', statOf('other'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('invalid')
    expect(result.error.path).toBe('/dev/null')
  })
})

describe('abortedResult', () => {
  it('returns an aborted FileError when the signal is already aborted', () => {
    const controller = new AbortController()
    controller.abort()
    const result = abortedResult(controller.signal, '/p')
    expect(result).toBeDefined()
    expect(result && !result.ok && result.error.code).toBe('aborted')
    expect(result && !result.ok && result.error.path).toBe('/p')
  })

  it('returns undefined for a live signal (lets the caller proceed)', () => {
    expect(abortedResult(new AbortController().signal, '/p')).toBeUndefined()
  })

  it('returns undefined when no signal is provided', () => {
    expect(abortedResult(undefined, '/p')).toBeUndefined()
  })
})

describe('splitLines', () => {
  it('returns an empty array for empty input', () => {
    expect(splitLines('')).toEqual([])
  })

  it('drops exactly one trailing newline ("a\\nb\\n" -> [a, b])', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
  })

  it('keeps a line that lacks a trailing newline', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
  })

  it('handles CRLF the same as LF', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
  })

  it('preserves interior blank lines', () => {
    expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b'])
  })

  it('drops only ONE trailing empty line, keeping a second one (two trailing newlines)', () => {
    // "a\n\n" -> split = [a, "", ""] -> pop one -> [a, ""]. A double-newline at
    // EOF must keep a representative blank line.
    expect(splitLines('a\n\n')).toEqual(['a', ''])
  })

  it('a lone newline yields a single empty line', () => {
    expect(splitLines('\n')).toEqual([''])
  })
})
