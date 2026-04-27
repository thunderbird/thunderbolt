/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'bun:test' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Matchers<T> extends TestingLibraryMatchers<string, T> {
    toBeNullOrUndefined(): void
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface AsymmetricMatchers extends TestingLibraryMatchers {}
}
