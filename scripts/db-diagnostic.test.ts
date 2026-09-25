/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { parseDbDiagnostic } from '../e2e/db-diagnostic'

test('accepts finite database outcomes for each startup phase', () => {
  expect(parseDbDiagnostic('[THU884-DB] readiness=pending category=other name=other')).toEqual({
    phase: 'readiness',
    label: '[THU884-DB] readiness=pending category=other name=other',
  })
  expect(parseDbDiagnostic('[THU884-DB] query=rejected category=locked name=NoModificationAllowedError')).toEqual({
    phase: 'query',
    label: '[THU884-DB] query=rejected category=locked name=NoModificationAllowedError',
  })
})

test('rejects arbitrary browser console data', () => {
  expect(
    parseDbDiagnostic('[THU884-DB] query=rejected category=locked name=NoModificationAllowedError token=secret'),
  ).toBeNull()
  expect(parseDbDiagnostic('[THU884-DB] query=rejected category=https://example.test name=other')).toBeNull()
  expect(parseDbDiagnostic('auth token=secret')).toBeNull()
})
