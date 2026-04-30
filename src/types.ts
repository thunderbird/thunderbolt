/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LanguageModelV2Usage } from '@ai-sdk/provider'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { SourceMetadata } from './types/source'
import type { Window } from '@tauri-apps/api/window'
import type { UIDataTypes, UIMessage, UITools } from 'ai'
import type { DrizzleQuery } from '@powersync/drizzle-driver'
import type { InferSelectModel } from 'drizzle-orm'
import { type PostHog } from 'posthog-js'
import type { z } from 'zod'
import type { HttpClient } from './contexts'
import type { AnyDrizzleDatabase } from './db/database-interface'
import type {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelProfilesTable,
  modelsTable,
  modesTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from './db/tables'

export type InitData = {
  db: AnyDrizzleDatabase
  cloudUrl: string
  tray: TrayIcon | undefined
  window: Window | undefined
  posthogClient: PostHog | null
  httpClient: HttpClient
  experimentalFeatureTasks: boolean
}

export type ThunderboltUIMessage = UIMessage<UIMessageMetadata, UIDataTypes, UITools>

export type SaveMessagesFunction = ({ id, messages }: { id: string; messages: ThunderboltUIMessage[] }) => Promise<void>

/**
 * Helper type to make specific keys required (non-null).
 * Used to create application types from row types where certain fields
 * should be guaranteed to be present for non-deleted records.
 */
type WithRequired<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> }

// Row types - Raw database row types matching the nullable schema
export type ChatMessageRow = InferSelectModel<typeof chatMessagesTable>
export type ChatThreadRow = InferSelectModel<typeof chatThreadsTable>
export type Setting = InferSelectModel<typeof settingsTable>
export type ModelRow = InferSelectModel<typeof modelsTable>
export type ModeRow = InferSelectModel<typeof modesTable>
export type TaskRow = InferSelectModel<typeof tasksTable>
export type McpServerRow = InferSelectModel<typeof mcpServersTable>
export type PromptRow = InferSelectModel<typeof promptsTable>
export type TriggerRow = InferSelectModel<typeof triggersTable>
export type ModelProfileRow = InferSelectModel<typeof modelProfilesTable>

// Application types - Row types with previously-required fields made non-null
export type ChatMessage = WithRequired<ChatMessageRow, 'content' | 'role' | 'chatThreadId'>
export type ChatThread = WithRequired<ChatThreadRow, 'isEncrypted' | 'wasTriggeredByAutomation'>
export type Model = WithRequired<
  ModelRow,
  | 'provider'
  | 'name'
  | 'model'
  | 'enabled'
  | 'toolUsage'
  | 'isConfidential'
  | 'startWithReasoning'
  | 'supportsParallelToolCalls'
>
export type Mode = WithRequired<ModeRow, 'name' | 'label' | 'icon' | 'order'>
export type Task = WithRequired<TaskRow, 'item' | 'order' | 'isComplete'>
export type McpServer = WithRequired<McpServerRow, 'name' | 'type' | 'enabled'>
export type Prompt = WithRequired<PromptRow, 'prompt' | 'modelId'>
export type Trigger = WithRequired<TriggerRow, 'triggerType' | 'isEnabled' | 'promptId'>
export type ModelProfile = WithRequired<ModelProfileRow, 'modelId'>

/**
 * Query usable with PowerSync's toCompilableQuery and direct await.
 * When awaited, resolves to T[] without manual cast.
 */
export type DrizzleQueryWithPromise<T> = DrizzleQuery<T> & PromiseLike<T[]>

export type AutomationRun = {
  prompt: Prompt | null
  wasTriggeredByAutomation: boolean
  isAutomationDeleted: boolean
}

export type UIMessageMetadata = {
  modelId?: string
  usage?: LanguageModelV2Usage
  oauthRetry?: boolean
  reasoningTime?: Record<string, number>
  reasoningStartTimes?: Record<string, number>
  sources?: SourceMetadata[]
}

export type ToolConfig = {
  name: string
  description: string
  verb: string
  parameters: z.ZodObject<any, any>
  execute: (params: any) => Promise<any>
}

export type AuthProviderBackendConfig = {
  client_id: string
  // Optional for backward-compat with pre-patch backends that only return client_id.
  // Callers should treat `undefined` as configured when a client_id is present.
  configured?: boolean
}

// Re-export types from schemas to maintain backward compatibility
export type { CountryUnitsData, Currency, DateFormat, TemperatureUnit, UnitsOptionsData } from './schemas/api'

export type PreferencesSettings = {
  locationName: string
  locationLat: string
  locationLng: string
  preferredName: string
  dataCollection: boolean
  experimentalFeatureTasks: boolean
  distanceUnit: string
  temperatureUnit: string
  dateFormat: string
  timeFormat: string
  currency: string
  countryName: string | null
}
