/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { canInstallThunderboltCli, describeCliInstallError, isCliInstallError } from './cli-install'

describe('canInstallThunderboltCli', () => {
  it('offers the install for every published OS and architecture pair', () => {
    expect(canInstallThunderboltCli('macos', 'aarch64')).toBe(true)
    expect(canInstallThunderboltCli('linux', 'x86_64')).toBe(true)
    expect(canInstallThunderboltCli('linux', 'aarch64')).toBe(true)
  })

  it('hides the install for unpublished OS and architecture pairs', () => {
    expect(canInstallThunderboltCli('macos', 'x86_64')).toBe(false)
    expect(canInstallThunderboltCli('windows', 'x86_64')).toBe(false)
    expect(canInstallThunderboltCli('ios', 'aarch64')).toBe(false)
    expect(canInstallThunderboltCli('android', 'aarch64')).toBe(false)
    expect(canInstallThunderboltCli('web', 'unknown')).toBe(false)
  })
})

describe('isCliInstallError', () => {
  it('accepts a well-formed typed error', () => {
    expect(isCliInstallError({ kind: 'notPublished', message: 'nope' })).toBe(true)
    expect(isCliInstallError({ kind: 'checksumMismatch', message: 'bad hash' })).toBe(true)
  })

  it('rejects unknown kinds and malformed shapes', () => {
    expect(isCliInstallError({ kind: 'boom', message: 'x' })).toBe(false)
    expect(isCliInstallError({ kind: 'download' })).toBe(false)
    expect(isCliInstallError({ message: 'x' })).toBe(false)
    expect(isCliInstallError('notPublished')).toBe(false)
    expect(isCliInstallError(null)).toBe(false)
  })
})

describe('describeCliInstallError', () => {
  it('offers the manual build fallback only when no binary exists to install', () => {
    expect(describeCliInstallError({ kind: 'unsupported', message: 'no binary' })).toEqual({
      message: 'no binary',
      showManualBuild: true,
    })
    expect(describeCliInstallError({ kind: 'notPublished', message: 'not yet' })).toEqual({
      message: 'not yet',
      showManualBuild: true,
    })
  })

  it('treats operational failures as retryable, not build-from-source', () => {
    expect(describeCliInstallError({ kind: 'download', message: 'offline' }).showManualBuild).toBe(false)
    expect(describeCliInstallError({ kind: 'checksumMismatch', message: 'tampered' }).showManualBuild).toBe(false)
    expect(describeCliInstallError({ kind: 'install', message: 'no perms' }).showManualBuild).toBe(false)
  })

  it('stringifies an untyped rejection without offering the build fallback', () => {
    expect(describeCliInstallError(new Error('ipc failed'))).toEqual({
      message: 'Error: ipc failed',
      showManualBuild: false,
    })
  })
})
