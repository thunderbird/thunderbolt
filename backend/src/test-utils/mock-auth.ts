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
