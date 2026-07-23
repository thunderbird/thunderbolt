/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'

type MockAuthClientOptions = {
  session?: {
    user: {
      id: string
      email: string
      name?: string
      isAnonymous?: boolean
    }
  } | null
  isPending?: boolean
  signInEmailOtp?: (options: {
    email: string
    otp: string
  }) => Promise<{ error: { message: string; code?: string } | null }>
  signInAnonymous?: () => Promise<{
    error: { status: number; code: string } | null
    data: { user: { id: string } } | null
  }>
  sendVerificationOtp?: (options: { email: string; type: string }) => Promise<{ error: { message: string } | null }>
  signOut?: () => Promise<void>
  getSession?: () => Promise<{ data: unknown; error: { message: string } | null }>
  /**
   * Stand-in for the Better Auth client's `$fetch`. Lets tests drive raw endpoint
   * calls (e.g. the device-authorization `/device*` routes) without a real network.
   */
  fetch?: (path: string, options?: unknown) => Promise<{ data: unknown; error: unknown }>
}

/**
 * Creates a mock auth client for testing
 * Default state is logged out (session: null, isPending: false)
 */
export const createMockAuthClient = (options: MockAuthClientOptions = {}): AuthClient => {
  const {
    session = null,
    isPending = false,
    signInEmailOtp = async () => ({ error: null }),
    signInAnonymous = async () => ({ error: null, data: { user: { id: 'anon-mock' } } }),
    sendVerificationOtp = async () => ({ error: null }),
    signOut = async () => {},
    getSession = async () => ({ data: session, error: null }),
    fetch = async () => ({ data: null, error: null }),
  } = options

  // Use unknown first to bypass strict type checking for test mocks
  return {
    useSession: () => ({
      data: session,
      isPending,
      isRefetching: false,
      error: null,
      refetch: async () => ({ data: session, error: null }),
    }),
    getSession,
    signIn: {
      emailOtp: signInEmailOtp,
      anonymous: signInAnonymous,
    },
    emailOtp: {
      sendVerificationOtp,
    },
    signOut,
    $fetch: fetch,
    $Infer: {} as AuthClient['$Infer'],
  } as unknown as AuthClient
}
