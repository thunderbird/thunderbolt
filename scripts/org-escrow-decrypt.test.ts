/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Secret resolution for the offline escrow tool. The property under test is
 * that the escrow private key and the DB URL can only arrive out of band — an
 * env var or a file — and that every rejected shape fails loudly instead of
 * falling back to a weaker source.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSecret } from './org-escrow-decrypt'

const spec = { label: 'operator escrow private key', envVar: 'ORG_ESCROW_PRIVATE_KEY', fileFlag: 'private-key-file' }

const writeTempFile = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'escrow-secret-')), 'secret')
  writeFileSync(path, contents)
  return path
}

describe('resolveSecret', () => {
  test('reads the value from the env var', () => {
    expect(resolveSecret({ ...spec, envValue: 'MIGHAgEAMBMG' })).toBe('MIGHAgEAMBMG')
  })

  test('reads the value from a file, stripping the trailing newline', () => {
    expect(resolveSecret({ ...spec, filePath: writeTempFile('MIGHAgEAMBMG\n') })).toBe('MIGHAgEAMBMG')
  })

  test('throws when neither source is given', () => {
    expect(() => resolveSecret(spec)).toThrow('set ORG_ESCROW_PRIVATE_KEY or pass --private-key-file')
  })

  test('throws when both sources are given rather than silently preferring one', () => {
    const call = () => resolveSecret({ ...spec, filePath: writeTempFile('from-file'), envValue: 'from-env' })
    expect(call).toThrow('pass either --private-key-file or ORG_ESCROW_PRIVATE_KEY, not both')
  })

  test('throws when the file does not exist', () => {
    expect(() => resolveSecret({ ...spec, filePath: '/nonexistent/escrow.key' })).toThrow(
      'cannot read --private-key-file /nonexistent/escrow.key',
    )
  })

  test('throws when the file holds only whitespace', () => {
    expect(() => resolveSecret({ ...spec, filePath: writeTempFile('  \n') })).toThrow('is empty')
  })

  test('throws when the env var is set to whitespace', () => {
    expect(() => resolveSecret({ ...spec, envValue: '   ' })).toThrow('ORG_ESCROW_PRIVATE_KEY is set but blank')
  })

  test('treats an empty env var as unset so a file still resolves', () => {
    expect(resolveSecret({ ...spec, filePath: writeTempFile('from-file'), envValue: '' })).toBe('from-file')
  })

  test('never leaks the value into the error message', () => {
    const secret = 'super-secret-pkcs8'
    const call = () => resolveSecret({ ...spec, filePath: writeTempFile(secret), envValue: secret })
    expect(call).toThrow('not both')
    expect(call).not.toThrow(secret)
  })
})
