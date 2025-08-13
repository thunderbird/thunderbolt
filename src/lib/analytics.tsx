import { getCloudUrl } from '@/lib/config'
import { getBooleanSetting } from '@/lib/dal'
import ky from 'ky'
import type { PostHog } from 'posthog-js'
import posthog from 'posthog-js'
import { PostHogProvider as PostHogReactProvider } from 'posthog-js/react'
import { ReactNode, useEffect, useState } from 'react'

let posthogClient: PostHog | null = null

/**
 * Initialize Posthog analytics and return the client
 */
export const initPosthog = async (): Promise<PostHog | null> => {
  const cloudUrl = await getCloudUrl()

  // Fetch public analytics config from backend
  const { posthog_api_key: posthogApiKey }: { posthog_api_key?: string } = await ky
    .get(`${cloudUrl}/analytics/config`)
    .json()

  if (!posthogApiKey) {
    console.log('Posthog analytics disabled - no API key provided')
    return null
  }

  // Use the cloudUrl proxy for PostHog analytics
  const apiHost = `${cloudUrl}/posthog`

  if (!posthogClient) {
    const enableDebug = await getBooleanSetting('debug_posthog', false)
    posthogClient = posthog.init(posthogApiKey, {
      api_host: apiHost,
      debug: enableDebug,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      persistence: 'localStorage',
    }) as PostHog
  }

  return posthogClient
}

/**
 * PostHog Provider component for React
 */
export const PostHogProvider = ({ children }: { children: ReactNode }) => {
  const [client, setClient] = useState<PostHog | null>(null)

  useEffect(() => {
    initPosthog().then(setClient)
  }, [])

  if (!client) return <>{children}</>

  return <PostHogReactProvider client={client}>{children}</PostHogReactProvider>
}
