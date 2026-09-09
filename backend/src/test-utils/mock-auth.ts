/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'

type MockAuthSession = {
  user: { id: string; isAnonymous?: boolean }
  session: Record<string, never>
}

/** Creates an auth test double with the supplied session lookup. */
const createAuth = (getSession: () => Promise<MockAuthSession>): Auth => {
  const api: typeof mockAuth.api = Object.create(mockAuth.api)
  Object.defineProperty(api, 'getSession', { value: getSession })
  const auth: Auth = Object.create(mockAuth)
  Object.defineProperty(auth, 'api', { value: api })
  return auth
}

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

/** Creates an authenticated session for the supplied test user. */
export const createMockAuth = (id: string, isAnonymous?: boolean): Auth => {
  const testUser = isAnonymous === undefined ? { id } : { id, isAnonymous }
  return createAuth(() => Promise.resolve({ user: testUser, session: {} }))
}

/** Creates an auth test double whose session lookup rejects. */
export const createThrowingAuth = (error: Error): Auth => createAuth(() => Promise.reject(error))
