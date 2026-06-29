/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Normalizes an email address for consistent storage and comparison.
 * - Converts to lowercase
 * - Trims whitespace
 */
export const normalizeEmail = (email: string) => email.toLowerCase().trim()

/**
 * Format check (same regex as the FE's `isValidEmailFormat`) — guards
 * upload-handler inserts against junk strings before they hit the DB. Run
 * against the normalized form so case/whitespace don't sneak past.
 */
const emailRegex =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/

export const isValidEmailFormat = (email: string): boolean => emailRegex.test(normalizeEmail(email))
