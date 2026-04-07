// New file with Microsoft Graph tools

import { getSettings, updateSettings } from '@/dal'
import { getDb } from '@/db/database'
import { llmContentCharLimit } from '@/lib/utils'
import type { ToolConfig } from '@/types'
import { http, type HttpClient } from '@/lib/http'
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

export const searchOneDriveSchema = z
  .object({
    query: z.string().describe('Search query to find files in OneDrive'),
    max_results: z.number().optional().default(20).describe('Maximum number of files to return (default: 20, max: 50)'),
  })
  .strict()

export const getOneDriveFileContentSchema = z
  .object({
    file_id: z.string().describe('The OneDrive file ID to retrieve content from'),
  })
  .strict()

export type ListMessagesParams = z.infer<typeof listMessagesSchema>
export type GetMessageParams = z.infer<typeof getMessageSchema>
export type SearchOneDriveParams = z.infer<typeof searchOneDriveSchema>
export type GetOneDriveFileContentParams = z.infer<typeof getOneDriveFileContentSchema>

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

type OneDriveFile = {
  id: string
  name: string
  size?: number
  createdDateTime?: string
  lastModifiedDateTime?: string
  webUrl?: string
  file?: { mimeType?: string }
  folder?: { childCount?: number }
  parentReference?: { path?: string }
}

type OneDriveSearchResponse = {
  value?: OneDriveFile[]
  '@odata.nextLink'?: string
}

export type OneDriveFileResult = {
  id: string
  name: string
  mime_type: string
  size_bytes?: number
  created_time: string
  modified_time: string
  web_url: string
  is_folder: boolean
  path?: string
}

/**
 * Result of attempting to extract text content from a OneDrive file.
 * Uses structured metadata to let the LLM craft appropriate responses.
 */
export type OneDriveFileContent = {
  file_id: string
  file_name: string
  mime_type: string
  content: string | null
  isTruncated?: boolean
  extraction_failed?: boolean
  failure_reason?: 'unsupported_type' | 'access_denied' | 'not_found'
  file_category?: 'pdf' | 'image' | 'video' | 'audio' | 'binary' | 'office' | 'unknown'
}

/** Categorize MIME type for LLM context when file type is unsupported */
const getOneDriveFileCategory = (mime: string): OneDriveFileContent['file_category'] => {
  if (mime === 'application/pdf') {
    return 'pdf'
  }
  if (mime.startsWith('image/')) {
    return 'image'
  }
  if (mime.startsWith('video/')) {
    return 'video'
  }
  if (mime.startsWith('audio/')) {
    return 'audio'
  }
  if (
    mime.includes('officedocument') ||
    mime.includes('msword') ||
    mime.includes('ms-excel') ||
    mime.includes('ms-powerpoint')
  ) {
    return 'office'
  }
  if (mime.includes('octet-stream') || mime.includes('binary')) {
    return 'binary'
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const getMicrosoftCredentials = async () => {
  const db = getDb()
  const settings = await getSettings(db, { integrations_microsoft_credentials: String })
  const credentialsStr = settings.integrationsMicrosoftCredentials
  if (!credentialsStr) {
    throw new Error('Microsoft integration not connected')
  }

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
    if (!credentials.refresh_token) {
      throw new Error('Access token expired and no refresh token available')
    }

    const { refreshAccessToken } = await import('@/lib/auth')
    const newTokens = await refreshAccessToken('microsoft', credentials.refresh_token)
    const updated = {
      ...credentials,
      access_token: newTokens.access_token,
      expires_at: Date.now() + newTokens.expires_in * 1000,
    }

    const db = getDb()
    await updateSettings(db, { integrations_microsoft_credentials: JSON.stringify(updated) })

    return newTokens.access_token
  }

  return credentials.access_token
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const listMessages = async (params: ListMessagesParams, httpClient: HttpClient = http) => {
  const credentials = await getMicrosoftCredentials()
  const accessToken = await ensureValidToken(credentials)

  const searchParams = new URLSearchParams()
  if (params.top) {
    searchParams.set('$top', params.top.toString())
  }
  if (params.skipToken) {
    searchParams.set('$skiptoken', params.skipToken)
  }
  if (params.filter) {
    searchParams.set('$filter', params.filter)
  }

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

export const getMessage = async (params: GetMessageParams, httpClient: HttpClient = http) => {
  const credentials = await getMicrosoftCredentials()
  const accessToken = await ensureValidToken(credentials)

  const selectParams = params.includeBodyHtml
    ? '$select=subject,body,bodyPreview,from,toRecipients,receivedDateTime'
    : ''
  const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${params.id}`)
  if (selectParams) {
    url.searchParams.set('$select', selectParams.replace('$select=', ''))
  }

  const message = await httpClient
    .get(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<GraphMessage>()

  return message
}

/**
 * Search OneDrive files
 */
export const searchOneDrive = async (params: SearchOneDriveParams, httpClient: HttpClient = http) => {
  const credentials = await getMicrosoftCredentials()
  const accessToken = await ensureValidToken(credentials)

  const searchParams = new URLSearchParams()
  searchParams.set('$top', Math.min(params.max_results ?? 20, 50).toString())
  searchParams.set('$select', 'id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,folder,parentReference')

  const response = await httpClient
    .get(`https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(params.query)}')`, {
      searchParams,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<OneDriveSearchResponse>()

  const files: OneDriveFileResult[] = (response.value || []).map((file) => ({
    id: file.id,
    name: file.name,
    mime_type: file.file?.mimeType || (file.folder ? 'folder' : 'application/octet-stream'),
    size_bytes: file.size,
    created_time: file.createdDateTime || '',
    modified_time: file.lastModifiedDateTime || '',
    web_url: file.webUrl || '',
    is_folder: !!file.folder,
    path: file.parentReference?.path,
  }))

  return {
    files,
    total_count: files.length,
    has_more: !!response['@odata.nextLink'],
  }
}

/**
 * Get text content from a OneDrive file
 * Works with text files only. Returns structured metadata for unsupported types.
 */
export const getOneDriveFileContent = async (
  params: GetOneDriveFileContentParams,
  httpClient: HttpClient = http,
): Promise<OneDriveFileContent> => {
  const credentials = await getMicrosoftCredentials()
  const accessToken = await ensureValidToken(credentials)

  try {
    // Get file metadata
    const fileResponse = await httpClient
      .get(`https://graph.microsoft.com/v1.0/me/drive/items/${params.file_id}`, {
        searchParams: { $select: 'id,name,file' },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .json<OneDriveFile>()

    const fileName = fileResponse.name || 'Unknown'
    const mimeType = fileResponse.file?.mimeType || 'application/octet-stream'

    // Only support text files for now
    if (mimeType.startsWith('text/')) {
      const textContent = await httpClient
        .get(`https://graph.microsoft.com/v1.0/me/drive/items/${params.file_id}/content`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        .text()

      const isTruncated = textContent.length > llmContentCharLimit

      return {
        file_id: params.file_id,
        file_name: fileName,
        mime_type: mimeType,
        content: isTruncated ? textContent.substring(0, llmContentCharLimit) + '...[truncated]' : textContent,
        isTruncated,
      }
    }

    // Unsupported file type - return structured metadata for LLM
    return {
      file_id: params.file_id,
      file_name: fileName,
      mime_type: mimeType,
      content: null,
      extraction_failed: true,
      failure_reason: 'unsupported_type',
      file_category: getOneDriveFileCategory(mimeType),
    }
  } catch (error: unknown) {
    const httpError = error as { response?: { status: number } }
    if (httpError.response?.status === 403) {
      return {
        file_id: params.file_id,
        file_name: 'Unknown',
        mime_type: 'unknown',
        content: null,
        extraction_failed: true,
        failure_reason: 'access_denied',
      }
    }

    if (httpError.response?.status === 404) {
      return {
        file_id: params.file_id,
        file_name: 'Unknown',
        mime_type: 'unknown',
        content: null,
        extraction_failed: true,
        failure_reason: 'not_found',
      }
    }

    throw error
  }
}

// ---------------------------------------------------------------------------
// Tool configs consumed by the UI / AI layer
// ---------------------------------------------------------------------------

/**
 * Microsoft Tools Configuration Factory
 * @param httpClient - HTTP client for making requests (injected for dependency injection)
 */
export const createConfigs = (httpClient: HttpClient): ToolConfig[] => [
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
  {
    name: 'microsoft_search_onedrive',
    description: 'Search OneDrive files by name or content',
    verb: 'Searching OneDrive',
    parameters: searchOneDriveSchema,
    execute: (params: SearchOneDriveParams) => searchOneDrive(params, httpClient),
  },
  {
    name: 'microsoft_get_onedrive_file_content',
    description:
      'Get text content from a OneDrive file. Currently supports text files only. For unsupported types (PDFs, Office docs, images, etc.), returns file metadata with extraction_failed=true - explain the limitation helpfully to the user.',
    verb: 'Getting OneDrive file content',
    parameters: getOneDriveFileContentSchema,
    execute: (params: GetOneDriveFileContentParams) => getOneDriveFileContent(params, httpClient),
  },
]

/**
 * Default configs using the default http client
 * @deprecated Use createConfigs() with an injected httpClient instead
 */
export const configs = createConfigs(http)
