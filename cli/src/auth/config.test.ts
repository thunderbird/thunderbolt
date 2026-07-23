/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure resolver coverage for CLI auth config: cloud-URL / PAT env precedence and
 * the Better Auth base-URL derivation. Env is injected (not read from
 * `process.env`) so these stay side-effect-free.
 */

import { describe, expect, test } from 'bun:test'
import {
  apiBaseUrl,
  authBaseUrl,
  defaultAppUrl,
  defaultCloudUrl,
  isSecureCloudUrl,
  resolveAppUrl,
  resolveCloudUrl,
  resolvePatToken,
} from './config.ts'

describe('resolveCloudUrl', () => {
  test('prefers THUNDERBOLT_CLOUD_URL over the baked release default', () => {
    expect(resolveCloudUrl({ THUNDERBOLT_CLOUD_URL: 'https://runtime.example.com/v1' }, 'https://baked.example.com/v1')).toBe(
      'https://runtime.example.com/v1',
    )
  })

  test('uses the baked release default when the runtime override is unset', () => {
    expect(resolveCloudUrl({}, 'https://baked.example.com/v1')).toBe('https://baked.example.com/v1')
  })

  test('falls back to the localhost default when unset or empty', () => {
    expect(resolveCloudUrl({})).toBe(defaultCloudUrl)
    expect(resolveCloudUrl({ THUNDERBOLT_CLOUD_URL: '' })).toBe(defaultCloudUrl)
  })
})

describe('resolveAppUrl', () => {
  test('prefers THUNDERBOLT_APP_URL over the baked release default', () => {
    expect(resolveAppUrl({ THUNDERBOLT_APP_URL: 'https://runtime.example.com' }, 'https://baked.example.com')).toBe(
      'https://runtime.example.com',
    )
  })

  test('uses the baked release default when the runtime override is unset', () => {
    expect(resolveAppUrl({}, 'https://baked.example.com')).toBe('https://baked.example.com')
  })

  test('falls back to the localhost default when unset or empty', () => {
    expect(resolveAppUrl({})).toBe(defaultAppUrl)
    expect(resolveAppUrl({ THUNDERBOLT_APP_URL: '' })).toBe(defaultAppUrl)
  })
})

describe('authBaseUrl', () => {
  test('rewrites a …/v1 cloud URL to the Better Auth base path', () => {
    expect(authBaseUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1/api/auth')
  })

  test('tolerates a trailing slash', () => {
    expect(authBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/api/auth')
  })

  test('appends the full path when the base lacks /v1', () => {
    expect(authBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1/api/auth')
  })
})

describe('apiBaseUrl', () => {
  test('preserves a cloud URL ending in /v1', () => {
    expect(apiBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })

  test('appends /v1 when the cloud URL lacks it', () => {
    expect(apiBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1')
  })

  test('removes trailing slashes before normalizing', () => {
    expect(apiBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1')
    expect(apiBaseUrl('https://api.example.com///')).toBe('https://api.example.com/v1')
  })
})

describe('resolvePatToken', () => {
  test('returns the PAT when set', () => {
    expect(resolvePatToken({ THUNDERBOLT_TOKEN: 'pat-abc' })).toBe('pat-abc')
  })

  test('is undefined when unset or empty', () => {
    expect(resolvePatToken({})).toBeUndefined()
    expect(resolvePatToken({ THUNDERBOLT_TOKEN: '' })).toBeUndefined()
  })
})

describe('isSecureCloudUrl', () => {
  test('accepts any https URL', () => {
    expect(isSecureCloudUrl('https://api.example.com/v1')).toBe(true)
  })

  test('accepts plain http only for loopback hosts', () => {
    expect(isSecureCloudUrl('http://localhost:8000/v1')).toBe(true)
    expect(isSecureCloudUrl('http://127.0.0.1:8000/v1')).toBe(true)
    expect(isSecureCloudUrl('http://api.localhost/v1')).toBe(true)
  })

  test('rejects plain http to a remote host (would leak the bearer)', () => {
    expect(isSecureCloudUrl('http://selfhost.example/v1')).toBe(false)
  })
})
