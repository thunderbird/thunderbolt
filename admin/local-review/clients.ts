/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { anonymousClient, emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import type { AppClients } from '@/app'
import { createClient } from '@/lib/http'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { localReviewFetch } from './transport'

/** Boot the real application with local-only transports on a dedicated development origin. */
export const prepareLocalReview = (): AppClients => {
  if (!import.meta.env.DEV || !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
    throw new Error('Local admin review requires a loopback development server')
  }
  const cloudUrl = new URL('/__local_review__/v1', window.location.origin).href
  useLocalSettingsStore.setState({ cloudUrl, syncEnabled: false })
  return {
    proxyFetch: Object.assign(localReviewFetch, { preconnect: async () => false }),
    httpClient: createClient({ prefixUrl: cloudUrl, fetch: localReviewFetch }),
    authClient: createAuthClient({
      baseURL: window.location.origin,
      basePath: '/__local_review__/v1/api/auth',
      plugins: [emailOTPClient(), anonymousClient()],
      fetchOptions: { customFetchImpl: localReviewFetch },
      sessionOptions: { refetchOnWindowFocus: false, refetchWhenOffline: false },
    }),
  }
}
