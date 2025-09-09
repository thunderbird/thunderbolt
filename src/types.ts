import type { LanguageModelV2Usage } from '@ai-sdk/provider'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import type { UIDataTypes, UIMessage, UITools } from 'ai'
import type { InferSelectModel } from 'drizzle-orm'
import type { z } from 'zod'
import type {
  chatMessagesTable,
  chatThreadsTable,
  contactsTable,
  emailAddressesTable,
  emailMessagesTable,
  emailMessagesToAddressesTable,
  emailThreadsTable,
  embeddingsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from './db/tables'
import type ImapClient from './imap/imap'
import type { ImapSyncClient } from './sync'

export type InitData = {
  imap: ImapClient
  imapSync: ImapSyncClient
  tray: TrayIcon | undefined
  window: Window | undefined
  sideviewType: SideviewType | null
  sideviewId: string | null
  initialThreadId: string
}

export type ThunderboltUIMessage = UIMessage<UIMessageMetadata, UIDataTypes, UITools>

export type SaveMessagesFunction = ({ id, messages }: { id: string; messages: ThunderboltUIMessage[] }) => Promise<void>

export type AccountsSettings = {
  hostname: string
  port: number
  username: string
  password: string
}

export type ModelsSettings = {
  openai_api_key: string
}

export type Settings = {
  account?: AccountsSettings
  models?: ModelsSettings
  last_generated_tasks_from_inbox?: string
}

export type ChatMessage = InferSelectModel<typeof chatMessagesTable>
export type ChatThread = InferSelectModel<typeof chatThreadsTable>
export type Setting = InferSelectModel<typeof settingsTable>
export type EmailMessage = InferSelectModel<typeof emailMessagesTable>
export type EmailThread = InferSelectModel<typeof emailThreadsTable>
export type EmailAddress = InferSelectModel<typeof emailAddressesTable>
export type EmailMessageToAddress = InferSelectModel<typeof emailMessagesToAddressesTable>
export type Embedding = InferSelectModel<typeof embeddingsTable>
export type Model = InferSelectModel<typeof modelsTable>
export type Task = InferSelectModel<typeof tasksTable>
export type Contact = InferSelectModel<typeof contactsTable>
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
}

export type EmailMessageWithAddresses = EmailMessage & {
  sender: EmailAddress
  recipients: (EmailMessageToAddress & {
    address: EmailAddress
  })[]
}

export type EmailThreadWithMessagesAndAddresses = EmailThread & {
  messages: EmailMessageWithAddresses[]
}

export type ParsedEmail = {
  attachments: unknown[]
  clean_text: string
  html_body: string
  text_body: string
  parts: ParsedEmailPart[]
}

export type ParsedEmailPart = {
  body: {
    Html?: string
    Text?: string
  }
  headers: ParsedEmailHeader[]
}

export type ParsedEmailHeader = {
  name:
    | string
    | {
        other: string
      }
  value: {
    Text?: string
    TextList?: string[]
    ContentType?: {
      c_type: string
      c_subtype: string
      attributes: string[][]
    }
  }
  offset_start: number
  offset_end: number
  offset_field: number
}

export type SideviewType = 'message' | 'thread' | 'imap'

export type ImapEmailAddress = {
  name: string
  address: string
}

export type ImapEmailMessage = {
  id: string
  imapId: string
  htmlBody: string
  textBody: string
  subject: string
  sentAt: number
  toAddresses: ImapEmailAddress[]
  fromAddress: ImapEmailAddress
  references: string[]
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
}
