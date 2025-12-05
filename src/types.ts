import type { LanguageModelV2Usage } from '@ai-sdk/provider'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import type { UIDataTypes, UIMessage, UITools } from 'ai'
import type { InferSelectModel } from 'drizzle-orm'
import { type PostHog } from 'posthog-js'
import type { z } from 'zod'
import type { HttpClient } from './contexts'
import type {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from './db/tables'

export type InitData = {
  tray: TrayIcon | undefined
  window: Window | undefined
  sideviewType: SideviewType | null
  sideviewId: string | null
  posthogClient: PostHog | null
  httpClient: HttpClient
}

export type ThunderboltUIMessage = UIMessage<UIMessageMetadata, UIDataTypes, UITools>

export type SaveMessagesFunction = ({ id, messages }: { id: string; messages: ThunderboltUIMessage[] }) => Promise<void>

export type ChatMessage = InferSelectModel<typeof chatMessagesTable>
export type ChatThread = InferSelectModel<typeof chatThreadsTable>
export type Setting = InferSelectModel<typeof settingsTable>
export type Model = InferSelectModel<typeof modelsTable>
export type Task = InferSelectModel<typeof tasksTable>
export type McpServer = InferSelectModel<typeof mcpServersTable>
export type Prompt = InferSelectModel<typeof promptsTable>
export type Trigger = InferSelectModel<typeof triggersTable>

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
}

export type SideviewType = 'message' | 'thread' | 'imap'

export type ToolConfig = {
  name: string
  description: string
  verb: string
  parameters: z.ZodObject<any, any>
  execute: (params: any) => Promise<any>
}

export type AuthProviderBackendConfig = {
  client_id: string
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
