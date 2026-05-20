/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type HttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
import { getLocalSetting } from '@/stores/local-settings-store'
import { createHandleError } from '@/lib/error-utils'
import { createClient } from '@/lib/http'
import type { HandleError, HandleResult } from '@/types/handle-errors'
import type { PostHog } from 'posthog-js'
import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

let posthogClient: PostHog | null = null

/**
 * Reset the PostHog client - for testing only
 */
export const resetPosthogClient = () => {
  posthogClient = null
}

const routePatterns = ['/chats/:chatThreadId'] as const

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

  for (const pattern of routePatterns) {
    const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`)
    if (regex.test(pathname)) {
      return url.replace(pathname, pattern)
    }
  }

  return url
}

export type PostHogInitResult = {
  client: PostHog | null
  telemetryAvailable: boolean
}

/**
 * Initialize PostHog analytics. Loads `posthog-js` via dynamic import only
 * after the user has opted in, so the SDK lives in an async chunk.
 * `telemetryAvailable` reports whether the backend has an API key configured.
 */
export const initPosthog = async (httpClient?: HttpClient): Promise<HandleResult<PostHogInitResult>> => {
  try {
    const cloudUrl = getLocalSetting('cloudUrl')
    const debugPosthog = getLocalSetting('debugPosthog')
    const db = getDb()
    const { dataCollection } = await getSettings(db, {
      data_collection: true,
    })

    const client = httpClient ?? createClient({ prefixUrl: cloudUrl })
    const { public_posthog_api_key: apiKey } = await client
      .get('posthog/config')
      .json<{ public_posthog_api_key?: string }>()

    if (!apiKey) {
      console.warn('Posthog analytics disabled - no API key provided')
      return { success: true, data: { client: null, telemetryAvailable: false } }
    }

    if (!dataCollection) {
      // Don't load the SDK until the user opts in.
      return { success: true, data: { client: null, telemetryAvailable: true } }
    }

    if (!posthogClient) {
      const { default: posthog } = await import('posthog-js')
      const apiHost = `${cloudUrl}/posthog`
      posthogClient = posthog.init(apiKey, {
        api_host: apiHost,
        debug: debugPosthog,
        autocapture: false,
        capture_exceptions: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_surveys: true,
        disable_session_recording: true,
        disable_scroll_properties: true,
        disable_external_dependency_loading: true,
        capture_performance: false,
        persistence: 'localStorage',
        before_send: (event) => {
          if (!event) {
            return null
          }
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

    return { success: true, data: { client: posthogClient, telemetryAvailable: true } }
  } catch (error) {
    console.warn('Failed to initialize PostHog, continuing without analytics:', error)
    return {
      success: false,
      error: createHandleError('POSTHOG_FETCH_FAILED', 'Failed to initialize PostHog analytics', error),
    }
  }
}

const TelemetryAvailableContext = createContext(false)

type PostHogClientContextValue = {
  client: PostHog | null
  setClient: Dispatch<SetStateAction<PostHog | null>>
}

const PostHogClientContext = createContext<PostHogClientContextValue | null>(null)

/**
 * True when the backend has a PostHog API key configured. Independent of the
 * user's `data_collection` consent.
 */
export const useTelemetryAvailable = () => useContext(TelemetryAvailableContext)

const usePostHogClientContext = (): PostHogClientContextValue => {
  const ctx = useContext(PostHogClientContext)
  if (!ctx) {
    throw new Error('PostHog hooks must be used inside <PostHogProvider>')
  }
  return ctx
}

/** Loaded PostHog client, or null when the SDK has not been initialized. */
export const usePosthog = (): PostHog | null => usePostHogClientContext().client

/** Publish a freshly-loaded client into the tree after a lazy opt-in init. */
export const useSetPosthog = (): Dispatch<SetStateAction<PostHog | null>> => usePostHogClientContext().setClient

export const PostHogProvider = ({
  children,
  initialClient,
  telemetryAvailable,
}: {
  children: ReactNode
  initialClient: PostHog | null
  telemetryAvailable: boolean
}) => {
  const [client, setClient] = useState<PostHog | null>(initialClient)
  const value = useMemo(() => ({ client, setClient }), [client])
  return (
    <TelemetryAvailableContext.Provider value={telemetryAvailable}>
      <PostHogClientContext.Provider value={value}>{children}</PostHogClientContext.Provider>
    </TelemetryAvailableContext.Provider>
  )
}

export type EventType =
  // Chat & Messaging
  | 'chat_send_prompt'
  | 'chat_send_prompt_overflow'
  | 'chat_receive_reply'
  | 'chat_auto_retry'
  | 'chat_select'
  | 'chat_new_clicked'
  | 'chat_delete'
  | 'chat_clear_all'
  // Model & Settings
  | 'model_select'
  | 'mode_select'
  | 'settings_theme_set'
  | 'settings_name_set'
  | 'settings_name_update'
  | 'settings_name_clear'
  | 'settings_location_set'
  | 'settings_location_update'
  | 'settings_localization_update'
  | 'settings_localization_reset'
  | 'settings_database_reset'
  | 'settings_data_collection_enabled'
  | 'settings_data_collection_disabled'
  | `settings_experimental_feature_tasks_enabled`
  | `settings_experimental_feature_tasks_disabled`
  | 'settings_sync_enabled'
  | 'settings_sync_disabled'
  // Tasks
  | 'task_add'
  | 'task_mark_complete'
  | 'task_update_text'
  | 'task_reorder'
  | 'task_search'
  // Automations
  | 'automation_modal_create_open'
  | 'automation_create'
  | 'automation_modal_edit_open'
  | 'automation_update'
  | 'automation_run'
  | 'automation_delete_clicked'
  | 'automation_delete_confirmed'
  // Content View & Preview
  | 'content_view_open'
  | 'content_view_close'
  | 'preview_open'
  | 'preview_close'
  | 'preview_copy_url'
  | 'preview_open_external'
  // UI & Navigation
  | 'ui_shortcut_use'
  | 'ui_sidebar_open'
  | 'ui_sidebar_close'
  // Sync Diagnostics
  | 'sync_connect'
  | 'sync_connect_error'
  | 'sync_disconnect'
  | 'sync_reconnect_start'
  | 'sync_reconnect_success'
  | 'sync_reconnect_error'
  | 'sync_visibility_change'
  | 'sync_credentials_fetch'
  | 'sync_credentials_error'
  | 'sync_upload'
  | 'sync_upload_error'
  | 'sync_status_change'

export const trackEvent = (eventName: EventType, properties?: Record<string, unknown>) => {
  try {
    if (posthogClient) {
      posthogClient.capture(eventName, properties)
    }
  } catch (error) {
    console.error('Failed to track event:', error)
  }
}

/**
 * Tracks errors using PostHog analytics
 * Only tracks non-PostHog errors to avoid circular tracking
 */
export const trackError = (error: HandleError, context?: Record<string, unknown>) => {
  try {
    // Don't track PostHog errors with PostHog to avoid circular tracking
    if (posthogClient && error.code !== 'POSTHOG_FETCH_FAILED') {
      posthogClient.captureException('$exception', {
        $exception_type: error.code,
        $exception_message: error.message,
        $exception_stack: error.stackTrace,
        ...context,
      })
    }
  } catch (trackingError) {
    console.error('Failed to track error:', trackingError)
  }
}
