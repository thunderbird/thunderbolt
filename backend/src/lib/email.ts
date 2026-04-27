/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Normalizes an email address for consistent storage and comparison.
 * - Converts to lowercase
 * - Trims whitespace
 */
export const normalizeEmail = (email: string) => email.toLowerCase().trim()
