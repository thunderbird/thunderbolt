/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { parseDbDiagnostic } from '../e2e/db-diagnostic'

test('accepts the database outcomes emitted during startup', () => {
  const diagnostics: Array<['readiness' | 'query', string]> = [
    ['readiness', '[db-diagnostic] readiness=pending category=other name=other'],
    ['readiness', '[db-diagnostic] readiness=ready category=other name=other'],
    ['readiness', '[db-diagnostic] readiness=rejected category=open name=InvalidStateError'],
    ['query', '[db-diagnostic] query=pending category=other name=other'],
    ['query', '[db-diagnostic] query=ready category=other name=other'],
    ['query', '[db-diagnostic] query=rejected category=locked name=NoModificationAllowedError'],
    ['query', '[db-diagnostic] query=timed_out category=other name=other'],
  ]

  for (const [phase, label] of diagnostics) {
    expect(parseDbDiagnostic(label)).toEqual({ phase, label })
  }
})

test('rejects near matches and appended browser data', () => {
  for (const message of [
    'Error: [db-diagnostic] query=ready category=other name=other',
    '[db-diagnostics] query=ready category=other name=other',
    '[db-diagnostic] query=ready category=other name=other token=secret',
    '[db-diagnostic] query=ready category=other name=other\nsecret',
  ]) {
    expect(parseDbDiagnostic(message)).toBeNull()
  }
})

test('rejects missing or invalid diagnostic fields', () => {
  for (const message of [
    '',
    '[db-diagnostic] query=ready category=other',
    '[db-diagnostic] startup=ready category=other name=other',
    '[db-diagnostic] query=failed category=other name=other',
    '[db-diagnostic] query=rejected category=https://example.test name=other',
    '[db-diagnostic] query=rejected category=other name=SecretError',
    'auth token=secret',
  ]) {
    expect(parseDbDiagnostic(message)).toBeNull()
  }
})
