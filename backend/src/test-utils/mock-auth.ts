/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'

/** Resolves to a valid session with a test user */
export const mockAuth = {
  api: {
    getSession: () => Promise.resolve({ user: { id: 'test-user' }, session: {} }),
  },
} as unknown as Auth

/** Resolves to null (unauthenticated) */
export const mockAuthUnauthenticated = {
  api: {
    getSession: () => Promise.resolve(null),
  },
} as unknown as Auth
