import type { ToolConfig } from '@/types'
import { http } from './http'
import { memoize } from './memoize'
import { getAvailableTools } from './tools'
import { Calendar, CloudSun, FileText, FolderSearch, Globe, Inbox, Mail, MailSearch, Search } from 'lucide-react'

export type ToolCategory = 'search' | 'data' | 'action' | 'analysis' | 'communication' | 'weather' | 'unknown'

export type ToolMetadata = {
  displayName: string
  initials: string
  loadingMessage: string
  category: ToolCategory
  icon: any
}

// Cache for performance
const metadataCache = new Map<string, ToolMetadata>()

/**
 * Get all available tool configurations with caching
 */
const getToolConfigs = memoize(async (): Promise<ToolConfig[]> => {
  return await getAvailableTools(http)
}, 'tool-configs')

/**
 * Get a specific tool configuration by name
 */
const getToolConfigByName = async (toolName: string): Promise<ToolConfig | undefined> => {
  const configs = await getToolConfigs()
  return configs.find((config) => config.name === toolName)
}

/**
 * Format a verb string with variable substitution
 */
const formatVerb = (verb: string, maxLength: number = 40, input: unknown = {}): string => {
  let formattedVerb = verb

  const inputObject = input as Record<string, unknown>

  // Replace variables in the format {variable_name} with actual values
  const variablePattern = /\{(\w+)\}/g
  formattedVerb = formattedVerb.replace(variablePattern, (_, varName) => {
    if (
      inputObject &&
      inputObject[varName] !== undefined &&
      inputObject[varName] !== null &&
      inputObject[varName] !== ''
    ) {
      const value = inputObject[varName]
      // Truncate long values
      if (typeof value === 'string' && value.length > maxLength) {
        return ` "${value.slice(0, maxLength)}..."`
      }
      return ` "${String(value)}"`
    }
    return '' // Remove placeholder if no value found
  })

  // Clean up any double spaces that might result from empty placeholders
  return formattedVerb.replace(/\s+/g, ' ').trim()
}

/**
 * Detects tool category based on name patterns
 */
const detectCategory = (toolName: string): ToolCategory => {
  const name = toolName.toLowerCase()

  if (/search|find|query|lookup|grep|codebase_search/.test(name)) {
    return 'search'
  }
  if (/fetch|get|retrieve|load|read|file_search/.test(name)) {
    return 'data'
  }
  if (/create|add|insert|generate|make|edit|write|delete|remove|update|modify|change|set|replace/.test(name)) {
    return 'action'
  }
  if (/analyze|process|calculate|compute|evaluate/.test(name)) {
    return 'analysis'
  }
  if (/send|email|message|notify|communicate/.test(name)) {
    return 'communication'
  }
  if (/weather|forecast|temperature|climate/.test(name)) {
    return 'weather'
  }

  return 'unknown'
}

/**
 * Formats tool name for display (snake_case/camelCase → Title Case)
 */
const formatDisplayName = (toolName: string): string =>
  toolName
    .replace(/[._-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 25)

/**
 * Generates contextual loading message
 */
const generateLoadingMessage = (toolName: string, category: ToolCategory, input?: unknown, verb?: string): string => {
  const inputObject = input as Record<string, unknown>

  // If verb is provided, use it with variable substitution
  if (verb) {
    const formattedVerb = formatVerb(verb, 40, input)
    // Capitalize first letter and add ellipsis
    return formattedVerb.charAt(0).toUpperCase() + formattedVerb.slice(1) + '...'
  }

  // Fallback to original logic
  const name = toolName.toLowerCase()

  // Context-aware messages with args
  if (input) {
    if (name.includes('search') && typeof inputObject.query === 'string') {
      const query = inputObject.query.slice(0, 20)
      return `Searching for "${query}${inputObject.query.length > 20 ? '...' : ''}"...`
    }
    if (name.includes('weather') && typeof inputObject.location === 'string') {
      return `Getting weather for ${inputObject.location}...`
    }
    if ((name.includes('edit') || name.includes('file')) && typeof inputObject.target_file === 'string') {
      const fileName = inputObject.target_file.split('/').pop() || inputObject.target_file
      return `${name.includes('edit') ? 'Editing' : 'Reading'} ${fileName}...`
    }
    if (name.includes('grep') && typeof inputObject.query === 'string') {
      const query = inputObject.query.slice(0, 15)
      return `Searching for "${query}${inputObject.query.length > 15 ? '...' : ''}"...`
    }
  }

  // Category fallbacks
  const messages: Record<ToolCategory, string> = {
    search: 'Searching...',
    data: 'Retrieving data...',
    action:
      name.includes('edit') || name.includes('write')
        ? 'Editing...'
        : name.includes('create') || name.includes('add')
          ? 'Creating...'
          : name.includes('delete') || name.includes('remove')
            ? 'Removing...'
            : 'Processing...',
    analysis: 'Analyzing...',
    communication: 'Sending...',
    weather: 'Getting weather...',
    unknown: 'Processing...',
  }

  // Return category message or final fallback
  return messages[category] || `Using "${toolName}" tool...`
}

const getToolIcon = (toolName: string) => {
  switch (toolName) {
    case 'get_current_weather':
    case 'get_weather_forecast':
      return CloudSun

    case 'search':
      return Search

    case 'google_check_inbox':
      return Inbox

    case 'google_search_emails':
      return MailSearch

    case 'google_get_email':
      return Mail

    case 'google_check_calendar':
      return Calendar

    case 'google_search_drive':
      return FolderSearch

    case 'google_get_drive_file_content':
      return FileText

    case 'fetch_content':
      return Globe

    default:
      return null
  }
}

const getDisplayNameInitials = (displayName: string) =>
  displayName
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()

/**
 * Gets tool metadata with caching for performance (async version)
 */
export const getToolMetadata = async (toolName: string, args?: unknown): Promise<ToolMetadata> => {
  const cacheKey = `${toolName}:${JSON.stringify(args || {})}`

  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey)!
  }

  // Try to get the tool config to use its verb
  const toolConfig = await getToolConfigByName(toolName)
  const category = detectCategory(toolName)

  const displayName = formatDisplayName(toolName)

  const metadata: ToolMetadata = {
    displayName,
    initials: getDisplayNameInitials(displayName),
    loadingMessage: generateLoadingMessage(toolName, category, args, toolConfig?.verb),
    category,
    icon: getToolIcon(toolName),
  }

  metadataCache.set(cacheKey, metadata)
  return metadata
}

/**
 * Gets tool metadata synchronously (without verb support)
 * This is a fallback for components that can't handle async operations
 */
export const getToolMetadataSync = (toolName: string, input?: unknown): ToolMetadata => {
  const cacheKey = `${toolName}:${JSON.stringify(input || {})}_sync`

  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey)!
  }

  const category = detectCategory(toolName)
  const displayName = formatDisplayName(toolName)

  const metadata: ToolMetadata = {
    displayName,
    initials: getDisplayNameInitials(displayName),
    loadingMessage: generateLoadingMessage(toolName, category, input),
    category,
    icon: getToolIcon(toolName),
  }

  metadataCache.set(cacheKey, metadata)
  return metadata
}
