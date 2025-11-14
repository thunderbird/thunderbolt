// New file with Microsoft Graph tools

import { getSettings, updateSetting } from '@/dal'
import type { ToolConfig } from '@/types'
import ky, { type KyInstance } from 'ky'
import { z } from 'zod'

/**
 * Schemas
 */
export const listMessagesSchema = z
  .object({
    top: z.number().describe('Maximum number of messages to return (1-1000)'),
    skipToken: z.string().describe('Skip token for paging (opaque string returned from previous response)'),
    filter: z.string().describe('OData $filter expression'),
    includeBodyHtml: z.boolean().describe('Whether to include the HTML body in each message'),
  })
  .strict()

export const getMessageSchema = z
  .object({
    id: z.string().describe('The ID of the message to retrieve'),
    includeBodyHtml: z.boolean().describe('Whether to include the HTML body in the message'),
  })
  .strict()

export type ListMessagesParams = z.infer<typeof listMessagesSchema>
export type GetMessageParams = z.infer<typeof getMessageSchema>

// ---------------------------------------------------------------------------
// Microsoft Graph minimal types (subset)
// ---------------------------------------------------------------------------

type GraphMessageBody = {
  contentType?: 'Text' | 'HTML'
  content?: string
}

type GraphMessage = {
  id?: string
  subject?: string
  bodyPreview?: string
  body?: GraphMessageBody
  [key: string]: unknown
}

export type GraphListMessagesResponse = {
  value?: GraphMessage[]
  '@odata.nextLink'?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const getMicrosoftCredentials = async () => {
  const settings = await getSettings({ integrations_microsoft_credentials: String })
  const credentialsStr = settings.integrationsMicrosoftCredentials
  if (!credentialsStr) throw new Error('Microsoft integration not connected')

  try {
    return JSON.parse(credentialsStr)
  } catch {
    throw new Error('Invalid Microsoft credentials')
  }
}

/** Refresh access token if needed */
const ensureValidToken = async (credentials: { access_token: string; refresh_token: string; expires_at?: number }) => {
  const now = Date.now()
  if (credentials.expires_at && credentials.expires_at < now) {
    if (!credentials.refresh_token) throw new Error('Access token expired and no refresh token available')

    const { refreshAccessToken } = await import('@/lib/auth')
    const newTokens = await refreshAccessToken('microsoft', credentials.refresh_token)
    const updated = {
      ...credentials,
      access_token: newTokens.access_token,
      expires_at: Date.now() + newTokens.expires_in * 1000,
    }

    await updateSetting('integrations_microsoft_credentials', JSON.stringify(updated))

    return newTokens.access_token
  }

  return credentials.access_token
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const listMessages = async (params: ListMessagesParams, httpClient: KyInstance = ky) => {
  const credentials = await getMicrosoftCredentials()
  const accessToken = await ensureValidToken(credentials)

  const searchParams = new URLSearchParams()
  if (params.top) searchParams.set('$top', params.top.toString())
  if (params.skipToken) searchParams.set('$skiptoken', params.skipToken)
  if (params.filter) searchParams.set('$filter', params.filter)

  const response = await httpClient
    .get('https://graph.microsoft.com/v1.0/me/messages', {
      searchParams,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<GraphListMessagesResponse>()

  if (params.includeBodyHtml && response.value) {
    const messagesWithBodies = await Promise.all(
      response.value.map(async (msg) => getMessage({ id: msg.id!, includeBodyHtml: true }, httpClient)),
    )
    return { ...response, value: messagesWithBodies }
  }

  return response
}

export const getMessage = async (params: GetMessageParams, httpClient: KyInstance = ky) => {
  const credentials = await getMicrosoftCredentials()
  const accessToken = await ensureValidToken(credentials)

  const selectParams = params.includeBodyHtml
    ? '$select=subject,body,bodyPreview,from,toRecipients,receivedDateTime'
    : ''
  const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${params.id}`)
  if (selectParams) url.searchParams.set('$select', selectParams.replace('$select=', ''))

  const message = await httpClient
    .get(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<GraphMessage>()

  return message
}

// ---------------------------------------------------------------------------
// Tool configs consumed by the UI / AI layer
// ---------------------------------------------------------------------------

/**
 * Microsoft Tools Configuration Factory
 * @param httpClient - HTTP client for making requests (injected for dependency injection)
 */
export const createConfigs = (httpClient: KyInstance): ToolConfig[] => [
  {
    name: 'microsoft_list_messages',
    description: 'List Microsoft Outlook messages with optional filtering',
    verb: 'Listing Microsoft messages',
    parameters: listMessagesSchema,
    execute: (params: ListMessagesParams) => listMessages(params, httpClient),
  },
  {
    name: 'microsoft_get_message',
    description: 'Get a specific Microsoft Outlook message by ID',
    verb: 'Getting Microsoft message',
    parameters: getMessageSchema,
    execute: (params: GetMessageParams) => getMessage(params, httpClient),
  },
]

/**
 * Default configs using the global ky instance
 * @deprecated Use createConfigs() with an injected httpClient instead
 */
export const configs = createConfigs(ky)
