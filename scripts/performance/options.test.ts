/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { localOrigin, positiveInteger, validateLabel } from './options'

test('accepts loopback HTTP origins and rejects remote, credentialed and misleading suffix URLs', () => {
  for (const origin of ['http://localhost:1436', 'https://127.0.0.1:1437', 'http://[::1]:1436']) {
    expect(localOrigin(`${origin}/`)).toBe(origin)
  }
  for (const url of [
    'https://example.com',
    'http://localhost.example.com',
    'ftp://localhost',
    'file://localhost/',
    'http://user:secret@localhost:1436',
    'http://localhost:1436/production',
    'http://localhost:1436/?redirect=remote',
    'http://localhost:1436/#remote',
  ]) {
    expect(() => localOrigin(url)).toThrow('loopback')
  }
})

test('rejects unsafe counts and artifact path traversal before launching browsers', () => {
  expect(positiveInteger('runs', '3')).toBe(3)
  for (const count of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => positiveInteger('runs', count)).toThrow('safe integer')
  }
  expect(() => validateLabel('before-mobile_1')).not.toThrow()
  for (const label of ['', '../outside', '/tmp/output', 'two words']) {
    expect(() => validateLabel(label)).toThrow('--label')
  }
})
