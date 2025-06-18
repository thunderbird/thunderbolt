import { DatabaseSingleton } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'

// Default model for Flower AI
// Note: Only meta/llama3.2-1b/instruct-fp16 is currently working with our Flower setup
// const FI_DEFAULT_MODEL = 'meta/llama3.2-1b/instruct-fp16'
const FI_DEFAULT_MODEL = 'mistralai/mistral-small-3.1-24b'

let flowerInstance: any = null

// Dynamically import FlowerIntelligence at runtime to avoid TypeScript compilation of the whole Flower codebase.
type ChatResponseResult = any
type Message = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export async function getFlowerApiKey(): Promise<string | undefined> {
  try {
    const db = DatabaseSingleton.instance.db
    const cloudUrlSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url')).get()
    const cloudUrl = (cloudUrlSetting?.value as string) || 'http://localhost:8000'

    const response = await fetch(`${cloudUrl}/flower/api-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to get Flower API key: ${response.statusText}`)
    }

    const data = await response.json()
    return data.api_key
  } catch (error) {
    console.error('Error getting Flower API key:', error)
    return undefined
  }
}

export async function initializeFlowerIntelligence(): Promise<any> {
  try {
    if (!flowerInstance) {
      // Use eval to avoid TypeScript compile-time module resolution
      // In production, this will load from the public directory
      // Using bundled version for browser compatibility
      const moduleUrl = '/flower/intelligence/ts/dist/flowerintelligence.bundled.es.js'
      const { FlowerIntelligence } = await (eval(`import("${moduleUrl}")`) as Promise<any>)
      flowerInstance = (FlowerIntelligence as any).instance
    }

    // Set up remote handoff
    flowerInstance.remoteHandoff = true

    // Get cloud URL from settings
    const db = DatabaseSingleton.instance.db
    const cloudUrlSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url')).get()
    const cloudUrl = (cloudUrlSetting?.value as string) || 'http://localhost:8000'

    // Configure Flower to use our proxy endpoint
    flowerInstance.baseUrl = `${cloudUrl}/flower`

    // Get API key
    const apiKey = await getFlowerApiKey()
    if (!apiKey) {
      throw new Error('Failed to get Flower API key')
    }

    flowerInstance.apiKey = apiKey

    return flowerInstance
  } catch (error) {
    console.error('Error initializing Flower Intelligence:', error)
    throw error
  }
}

export async function chatWithFlowerDirect(
  messages: Array<{ role: string; content: string }>,
  options: {
    model?: string
    stream?: boolean
    encrypt?: boolean
    onStreamEvent?: (event: { chunk: string }) => void
  } = {}
): Promise<ChatResponseResult> {
  const fi = await initializeFlowerIntelligence()

  // Convert messages to Flower format
  const flowerMessages: Message[] = messages.map((msg) => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  }))

  const response = await fi.chat({
    messages: flowerMessages,
    model: options.model || FI_DEFAULT_MODEL,
    stream: options.stream || false,
    // Note: Encryption currently returns error 50003, so defaulting to false
    encrypt: options.encrypt !== undefined ? options.encrypt : false,
    forceRemote: true,
    onStreamEvent: options.onStreamEvent,
  })

  return response
}

export { FI_DEFAULT_MODEL }
