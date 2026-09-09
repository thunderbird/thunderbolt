/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Namespace prefix reserved for CLI installations. */
export const cliDeviceIdPrefix = 'cli-'

const canonicalLowercaseUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Returns whether a value is a reserved CLI device ID with a canonical lowercase UUID. */
export const isCliDeviceId = (value: unknown): value is `cli-${string}` =>
  typeof value === 'string' &&
  value.startsWith(cliDeviceIdPrefix) &&
  canonicalLowercaseUuidPattern.test(value.slice(cliDeviceIdPrefix.length))
