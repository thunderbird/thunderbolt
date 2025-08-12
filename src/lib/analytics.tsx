import { getCloudUrl } from '@/lib/config'
import type { PostHog } from 'posthog-js'
import posthog from 'posthog-js'
import { PostHogProvider as PostHogReactProvider } from 'posthog-js/react'
import { ReactNode, useEffect, useState } from 'react'

let posthogClient: PostHog | null = null

/**
 * Initialize Posthog analytics and return the client
 */
export const initPosthog = async (): Promise<PostHog | null> => {
  const apiKey = import.meta.env.VITE_POSTHOG_API_KEY

  if (!apiKey) {
    console.log('Posthog analytics disabled - no API key provided')
    return null
  }

  // Get the cloud URL from settings
  const cloudUrl = await getCloudUrl()

  // Use the cloudUrl proxy for PostHog analytics
  const apiHost = `${cloudUrl}/posthog`

  if (!posthogClient) {
    posthogClient = posthog.init(apiKey, {
      api_host: apiHost,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      persistence: 'localStorage',
      loaded: (client) => {
        if (import.meta.env.DEV) {
          client.debug()
        }
      },
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
