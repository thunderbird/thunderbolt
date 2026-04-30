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
    }
  } | null
  isPending?: boolean
  signInEmailOtp?: (options: {
    email: string
    otp: string
  }) => Promise<{ error: { message: string; code?: string } | null }>
  sendVerificationOtp?: (options: { email: string; type: string }) => Promise<{ error: { message: string } | null }>
  signOut?: () => Promise<void>
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
    sendVerificationOtp = async () => ({ error: null }),
    signOut = async () => {},
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
    signIn: {
      emailOtp: signInEmailOtp,
    },
    emailOtp: {
      sendVerificationOtp,
    },
    signOut,
    $Infer: {} as AuthClient['$Infer'],
  } as unknown as AuthClient
}
