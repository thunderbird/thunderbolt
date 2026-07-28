/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Open-redirect guard shared by every stored-return-URL consumer: accepts only a
 * same-origin relative path (single leading `/` — `//host` is protocol-relative and
 * would leave the origin), so a poisoned stored value can never redirect off-origin.
 */
export const isSafeRelativePath = (value: string | null | undefined): value is string =>
  Boolean(value?.startsWith('/') && !value.startsWith('//'))
