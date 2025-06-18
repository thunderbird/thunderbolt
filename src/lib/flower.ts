/// <reference types="@flwr/flwr" />

import { DatabaseSingleton } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'

// Flower Intelligence module URL - using latest version
const FI_MODULE_URL = 'https://cdn.jsdelivr.net/npm/flower-intelligence@latest/dist/flwr-intelligence.iife.js'

// Default model for Flower AI
const FI_DEFAULT_MODEL = 'llama-3.1-70b-instruct'

let cachedFlowerModule: Promise<{ FlowerIntelligence: any }> | null = null

function getFlowerIntelligenceModule() {
  if (!cachedFlowerModule) {
    cachedFlowerModule = import(FI_MODULE_URL)
  }
  return cachedFlowerModule
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
    const { FlowerIntelligence } = await getFlowerIntelligenceModule()
    const fi = FlowerIntelligence.instance

    // Set up remote handoff
    fi.remoteHandoff = true

    // Get API key
    const apiKey = await getFlowerApiKey()
    if (!apiKey) {
      throw new Error('Failed to get Flower API key')
    }

    fi.apiKey = apiKey

    return fi
  } catch (error) {
    console.error('Error initializing Flower Intelligence:', error)
    throw error
  }
}

export async function chatWithFlower(
  messages: Array<{ role: string; content: string }>,
  options: {
    model?: string
    stream?: boolean
    encrypt?: boolean
    onStreamEvent?: (event: { chunk: string }) => void
  } = {}
): Promise<any> {
  const fi = await initializeFlowerIntelligence()

  const response = await fi.chat({
    model: options.model || FI_DEFAULT_MODEL,
    messages,
    stream: options.stream || false,
    encrypt: options.encrypt || true,
    forceRemote: true,
    onStreamEvent: options.onStreamEvent,
  })

  if (!response.ok) {
    throw new Error(response.failure?.description || 'Flower AI request failed')
  }

  return response
}

export { FI_DEFAULT_MODEL }

/**
 * Get or create Flower data.
 */
export const getOrCreateFlowerData = async () => {
  console.log('🌸 Starting getOrCreateFlowerData...')

  try {
    const db = DatabaseSingleton.instance.db

    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'flower_data')).get()

    if (setting?.value) {
      console.log('🌸 Found existing Flower data in database')
      return JSON.parse(setting.value as string)
    }

    console.log('🌸 No existing Flower data, creating new...')

    // Generate new Flower data
    const newFlowerData = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      // Add any other initialization data here
    }

    // Store in database
    await db
      .insert(settingsTable)
      .values({
        key: 'flower_data',
        value: JSON.stringify(newFlowerData),
      })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: JSON.stringify(newFlowerData) },
      })

    console.log('🌸 Created and stored new Flower data:', newFlowerData)
    return newFlowerData
  } catch (error) {
    console.error('Error in getOrCreateFlowerData:', error)
    throw error
  }
}
