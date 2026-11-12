/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type HttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'
import { getLocalSetting } from '@/stores/local-settings-store'
import { createHandleError } from '@/lib/error-utils'
import { createClient } from '@/lib/http'
import type { HandleError, HandleResult } from '@/types/handle-errors'
import type { PostHog } from 'posthog-js'
import { createContext, useContext, type ReactNode } from 'react'

let posthogClient: PostHog | null = null
// Only fixed startup events are buffered: no unbounded queue of user activity.
const startupEvents = new Set<EventType>(['app_init_timing', 'app_chat_ready', 'app_content_ready'])
const pendingStartupEvents = new Map<EventType, Record<string, unknown> | undefined>()

/** Standalone installs retain Thunderbolt telemetry without configuring an app server. */
export const getAnalyticsUrl = (cloudUrl: string): string =>
  cloudUrl.replace(/\/+$/, '') || 'https://api.thunderbolt.io/v1'

/**
 * Reset the PostHog client - for testing only
 */
export const resetPosthogClient = () => {
  posthogClient = null
  pendingStartupEvents.clear()
}

const routePatterns = [
  '/chats/:chatThreadId',
  '/projects/:projectId',
  '/apps/:appId',
  '/oauth/openrouter/:flowId',
  '/oauth/tinfoil/:flowId',
] as const

/**
 * Replaces dynamic URL segments and removes query strings and hashes so analytics do not collect secrets or raw IDs.
 * @param url - Full URL or pathname
 * @returns URL containing only its sanitized route
 */
export const sanitizeUrl = (url: string): string => {
  if (!URL.canParse(url, 'http://localhost')) {
    return '/unknown'
  }
  const parsed = new URL(url, 'http://localhost')
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  const pathname = parsed.pathname
  const routeOnlyUrl = URL.canParse(url) ? parsed.href : pathname
  for (const pattern of routePatterns) {
    const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}/?$`)
    if (regex.test(pathname)) {
      return routeOnlyUrl.replace(pathname, pattern)
    }
  }

  return routeOnlyUrl
}

const analyticsUrlProperties = new Set([
  'url',
  '$current_url',
  '$pathname',
  '$referrer',
  '$initial_current_url',
  '$initial_pathname',
  '$initial_referrer',
  '$session_entry_url',
  '$session_entry_pathname',
  '$session_entry_referrer',
])

/** Removes callback nonces from SDK session/person URL properties as well as event URLs. */
const sanitizeAnalyticsUrls = (value: unknown): void => {
  if (!value || typeof value !== 'object') {
    return
  }
  const properties = value as Record<string, unknown>
  for (const [key, child] of Object.entries(properties)) {
    if (analyticsUrlProperties.has(key) && typeof child === 'string') {
      properties[key] = sanitizeUrl(child)
    } else {
      sanitizeAnalyticsUrls(child)
    }
  }
}

// Synced row IDs and debug trace IDs can join usage back to an account even without identify().
// Provider/model names may contain user-defined values (including fine-tune account identifiers).
const privateAnalyticsProperties = new Set([
  'apikey',
  'authorization',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'password',
  'email',
  'name',
  'userid',
  'accountid',
  'user',
  'account',
  'id',
  'model',
  'modelname',
  'agent',
  'agentname',
  'error',
  'message',
  'stack',
  'stacktrace',
  'exceptionmessage',
  'exceptionstack',
])

/** Remove credentials, account-linked record identifiers, and raw error text before telemetry leaves the app. */
export const stripPrivateAnalyticsProperties = (value: unknown): void => {
  if (!value || typeof value !== 'object') {
    return
  }
  const properties = value as Record<string, unknown>
  for (const [key, child] of Object.entries(properties)) {
    const normalizedKey = key.replace(/[_$-]/g, '').toLowerCase()
    if (
      privateAnalyticsProperties.has(normalizedKey) ||
      /(user|account|chat|chatthread|task|skill|model|agent|project|trace)ids?$/.test(normalizedKey)
    ) {
      delete properties[key]
    } else {
      stripPrivateAnalyticsProperties(child)
    }
  }
}

type CaptureConsent = {
  /** The synced `data_collection` setting, false while its row is missing. */
  dataCollection: boolean
  syncEnabled: boolean
  /** Whether this device has completed its first sync. */
  hasSynced: boolean
}

/**
 * Whether this device may capture: `data_collection` is on and, when sync is on, the device has completed its first
 * sync. Before that, its local settings are defaults it seeded itself (the reason its writes are create-only then,
 * see `isCreateOnlyWrite`), so its `true` may be a guess about an account that opted out on another device.
 */
export const shouldCapture = ({ dataCollection, syncEnabled, hasSynced }: CaptureConsent): boolean =>
  dataCollection && (!syncEnabled || hasSynced)

/**
 * Opt this device's PostHog in or out to match `isCapturing`. PostHog keeps a choice of its own per device, saved by
 * the Preferences toggle, and `opt_out_capturing_by_default` applies only where none is saved, so the setting
 * overrides it here: that is what keeps an opt-out on one device in force on every other.
 */
export const setCapturing = (client: PostHog, isCapturing: boolean) => {
  if (isCapturing && client.has_opted_out_capturing()) {
    // Not the user's action on this device, so no `$opt_in` event.
    client.opt_in_capturing({ captureEventName: false })
  }
  if (!isCapturing && !client.has_opted_out_capturing()) {
    client.opt_out_capturing()
  }
}

/**
 * Initialize Posthog analytics and return the client
 * @param httpClient - Optional HTTP client for dependency injection.
 */
export const initPosthog = async (httpClient?: HttpClient): Promise<HandleResult<PostHog | null>> => {
  try {
    // Discard the account ID retained by older promotion-analytics builds.
    sessionStorage.removeItem('thunderbolt_pending_anon_id')
    const analyticsUrl = getAnalyticsUrl(getLocalSetting('cloudUrl'))
    const debugPosthog = getLocalSetting('debugPosthog')
    const db = getDb()

    const client = httpClient ?? createClient({ prefixUrl: analyticsUrl })
    const { public_posthog_api_key: apiKey } = await client
      .get('posthog/config', { timeout: 5_000, credentials: 'omit' })
      .json<{ public_posthog_api_key?: string }>()

    if (!apiKey) {
      console.warn('Posthog analytics disabled - no API key provided')
      return { success: true, data: null }
    }

    const apiHost = `${analyticsUrl}/posthog`

    const { default: posthog } = await import('posthog-js')
    // The app is already interactive: consent may have changed while config
    // or the SDK was loading. Read it immediately before attaching analytics.
    const { dataCollection } = await getSettings(db, { data_collection: false })
    const isCapturing = shouldCapture({
      dataCollection,
      syncEnabled: getLocalSetting('syncEnabled'),
      hasSynced: getPowerSyncInstance()?.currentStatus.hasSynced ?? false,
    })
    if (!posthogClient) {
      posthogClient = posthog.init(apiKey, {
        opt_out_capturing_by_default: !isCapturing,
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
        // Separate prior account-linked identities from device-only usage. Consent uses its
        // existing project-key storage independently, so an opt-out is never reset here.
        persistence_name: `thunderbolt_device_usage_v1_${apiKey}`,
        person_profiles: 'never',
        ip: false,
        save_campaign_params: false,
        save_referrer: false,
        advanced_disable_flags: true,
        before_send: (event) => {
          if (!event || event.event === '$identify' || event.event === '$create_alias') {
            return null
          }

          sanitizeAnalyticsUrls(event.properties)

          stripPrivateAnalyticsProperties(event.properties)

          return event
        },
      }) as PostHog
    }
    // The start state; `useAnalyticsConsent` keeps it following the setting while the app runs.
    setCapturing(posthogClient, isCapturing)

    if (isCapturing) {
      for (const [event, properties] of pendingStartupEvents) {
        posthogClient.capture(event, properties)
      }
    }
    pendingStartupEvents.clear()
    return { success: true, data: posthogClient }
  } catch (error) {
    console.warn('Failed to initialize PostHog, continuing without analytics:', error)
    return {
      success: false,
      error: createHandleError('POSTHOG_FETCH_FAILED', 'Failed to initialize PostHog analytics', error),
    }
  }
}

const PostHogClientContext = createContext<PostHog | null>(null)

/**
 * Access the nullable PostHog client from React. Returns null until {@link initPosthog}
 * resolves (analytics attaches a beat after first paint) or when analytics is disabled.
 */
export const usePostHogClient = () => useContext(PostHogClientContext)

/**
 * Whether telemetry is actually wired up (i.e. a PostHog client was successfully initialized
 * because the backend supplied a public API key). Derived from the client context — telemetry
 * is available exactly when a client exists — so self-hosted deployments without a configured
 * key return false regardless of the user's `data_collection` consent setting.
 */
export const useTelemetryAvailable = () => usePostHogClient() !== null

/**
 * PostHog Provider component for React. Carries the nullable client through an in-house
 * context so posthog-js/react is never statically imported (keeping the SDK out of the
 * entry chunk). {@link useTelemetryAvailable} derives from this same client.
 */
export const PostHogProvider = ({ children, client }: { children: ReactNode; client: PostHog | null }) => (
  <PostHogClientContext.Provider value={client}>{children}</PostHogClientContext.Provider>
)

export type EventType =
  // Chat & Messaging
  | 'chat_send_prompt'
  | 'chat_send_prompt_overflow'
  | 'chat_receive_reply'
  | 'chat_auto_retry'
  | 'chat_retry_success'
  | 'chat_retries_exhausted'
  | 'chat_turn_completed'
  | 'chat_turn_error'
  | 'chat_select'
  | 'chat_new_clicked'
  | 'chat_delete'
  | 'chat_clear_all'
  | 'tinfoil_attestation'
  | 'trustedrouter_attestation'
  // Model & Settings
  | 'model_select'
  | 'mode_select'
  | 'agent_select'
  | 'acp_mode_changed'
  | 'acp_config_options_changed'
  | 'settings_theme_set'
  | 'settings_name_set'
  | 'settings_name_update'
  | 'settings_name_clear'
  | 'settings_location_set'
  | 'settings_location_update'
  | 'settings_localization_update'
  | 'settings_external_link_behavior_update'
  | 'settings_localization_reset'
  | 'settings_database_reset'
  | 'settings_data_export'
  | 'settings_data_import'
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
  | 'search_palette_open'
  | 'search_result_select'
  | 'search_command_run'
  // Anonymous session & promotion
  | 'anonymous_user_promoted'
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
  // Skills v1 (THU-535) — see docs/architecture/skills-v1 spec §6.
  | 'skill_used'
  | 'skill_created'
  | 'skill_edited'
  | 'skill_deleted'
  | 'skill_pinned'
  | 'skill_unpinned'
  | 'skill_reordered'
  // Data migrations (THU-547) — drops out once THU-560 deletes the legacy
  // automations subsystem.
  | 'automations_migration_run'
  // Startup performance
  | 'app_init_timing'
  | 'app_chat_ready'
  | 'app_content_ready'

export const trackEvent = (eventName: EventType, properties?: Record<string, unknown>) => {
  try {
    if (posthogClient) {
      posthogClient.capture(eventName, properties)
    } else if (startupEvents.has(eventName)) {
      pendingStartupEvents.set(eventName, properties)
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
      // Error messages and stacks can contain provider responses, account IDs, or local paths.
      posthogClient.captureException(error.code, {
        $exception_type: error.code,
        ...context,
      })
    }
  } catch (trackingError) {
    console.error('Failed to track error:', trackingError)
  }
}
