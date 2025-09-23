import { getSettings } from '@/config/settings'
import { Exa } from 'exa-js'
import type { SimpleContext } from './context'

/**
 * Create an Exa client instance if API key is configured
 */
export const createExaClient = (): Exa | null => {
  const settings = getSettings()
  const apiKey = settings.exaApiKey

  if (!apiKey) {
    return null
  }

  return new Exa(apiKey)
}

/**
 * Search using Exa's neural search API
 */
export const searchExa = async (
  query: string,
  ctx: SimpleContext,
  maxResults = 10,
): Promise<Array<Record<string, unknown>>> => {
  const client = createExaClient()
  if (!client) {
    await ctx.error('Exa API key not configured')
    return []
  }

  try {
    await ctx.info(`Searching Exa for: ${query}`)

    // Use Exa's search with autoprompt for better results
    const response = await client.searchAndContents(query, {
      numResults: maxResults,
      useAutoprompt: true,
      type: 'neural',
    })

    // Convert results to dictionary format for compatibility
    const results: Array<Record<string, unknown>> = []
    response.results.forEach((result, idx) => {
      results.push({
        position: idx + 1,
        title: result.title,
        url: result.url,
        snippet: result.text || '',
        author: result.author || null,
        published_date: result.publishedDate || null,
      })
    })

    await ctx.info(`Found ${results.length} results`)
    return results
  } catch (error) {
    await ctx.error(`Exa search error: ${String(error)}`)
    throw error
  }
}

/**
 * Fetch content from a URL using Exa's privacy-protected proxy
 */
export const fetchContentExa = async (url: string, ctx: SimpleContext): Promise<string> => {
  const client = createExaClient()
  if (!client) {
    return 'Error: Exa API key not configured'
  }

  try {
    await ctx.info(`Fetching content from: ${url}`)

    // Use Exa's getContents method
    const response = await client.getContents([url], {
      text: {
        maxCharacters: 8000,
        includeHtmlTags: false,
      },
    })

    if (response.results && response.results.length > 0) {
      const content = response.results[0]
      // Return the text content
      return content.text || ''
    } else {
      return 'Error: No content found for the provided URL'
    }
  } catch (error) {
    await ctx.error(`Exa content fetch error: ${String(error)}`)
    return `Error: ${String(error)}`
  }
}
