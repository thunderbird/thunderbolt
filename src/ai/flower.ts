import { type FlowerClient } from '@/flower'
import ky from 'ky'

export type FlowerClientOptions = {
  apiKey?: string
  baseUrl?: string
  remoteHandoff?: boolean
}

/**
 * Creates a Flower client with API key from backend and base URL
 */
export const createFlowerClient = async ({
  apiKey,
  baseUrl,
  remoteHandoff,
}: FlowerClientOptions): Promise<FlowerClient> => {
  const { FlowerIntelligence } = await import('@flwr/flwr')

  const client = FlowerIntelligence.instance as unknown as FlowerClient

  // This currently DOES NOT have any effect - waiting for a fix in the @flwr/flwr package
  if (baseUrl) {
    client.baseUrl = baseUrl
  }

  if (apiKey) {
    client.apiKey = apiKey
  }

  client.remoteHandoff = remoteHandoff ?? true

  return client
}

/**
 * Fetches API key from the backend for Flower authentication
 */
export const getFlowerApiKey = async (cloudUrl: string): Promise<string | undefined> => {
  const response = await ky.post(`${cloudUrl}/flower/api-key`, { json: {} })
  const data = await response.json<{ api_key: string }>()
  return data.api_key
}

export const createConfiguredFlowerClient = async (cloudUrl: string): Promise<FlowerClient> => {
  const baseUrl = `${cloudUrl}/flower`

  const apiKey = await getFlowerApiKey(cloudUrl)

  const client = await createFlowerClient({
    baseUrl,
    remoteHandoff: true,
    apiKey,
  })

  return client
}
