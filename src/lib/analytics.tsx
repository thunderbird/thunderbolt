import { getCloudUrl } from '@/lib/config'
import { getBooleanSetting } from '@/lib/dal'
import ky from 'ky'
import type { PostHog } from 'posthog-js'
import posthog from 'posthog-js'
import { PostHogProvider as PostHogReactProvider } from 'posthog-js/react'
import { ReactNode, useEffect, useState } from 'react'

let posthogClient: PostHog | null = null

const ROUTE_PATTERNS = ['/chats/:chatThreadId'] as const

/**
 * Replaces dynamic URL segments with their parameter placeholders so analytics do not collect raw IDs.
 * @param url - Full URL or pathname
 * @returns URL with pathname replaced to match the route pattern
 */
export const sanitizeUrl = (url: string): string => {
  const pathname = (() => {
    try {
      return new URL(url, 'http://localhost').pathname
    } catch {
      return url.startsWith('/') ? url : `/${url}`
    }
  })()

  for (const pattern of ROUTE_PATTERNS) {
    const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`)
    if (regex.test(pathname)) return url.replace(pathname, pattern)
  }

  return url
}

/**
 * Initialize Posthog analytics and return the client
 */
export const initPosthog = async (): Promise<PostHog | null> => {
  const cloudUrl = await getCloudUrl()

  const { posthog_api_key: apiKey } = await ky.get(`${cloudUrl}/analytics/config`).json<{ posthog_api_key?: string }>()

  if (!apiKey) {
    console.log('Posthog analytics disabled - no API key provided')
    return null
  }

  // Use the cloudUrl proxy for PostHog analytics
  const apiHost = `${cloudUrl}/posthog`

  if (!posthogClient) {
    const isDataCollectionEnabled = await getBooleanSetting('data_collection', true)
    const enableDebug = await getBooleanSetting('debug_posthog', false)
    posthogClient = posthog.init(apiKey, {
      opt_out_capturing_by_default: !isDataCollectionEnabled,
      api_host: apiHost,
      debug: enableDebug,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      persistence: 'localStorage',
      before_send: (event) => {
        if (!event) return null
        if (event.event === '$pageview' || event.event === '$pageleave') {
          if (typeof event.properties?.$current_url === 'string') {
            event.properties.$current_url = sanitizeUrl(event.properties.$current_url)
          }
        }

        if (typeof event.properties?.url === 'string') {
          event.properties.url = sanitizeUrl(event.properties.url)
        }
        if (typeof event.properties?.$pathname === 'string') {
          event.properties.$pathname = sanitizeUrl(event.properties.$pathname)
        }

        return event
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
