import { type FlowerClient } from '@/flower'
import { getCloudUrl } from '@/lib/config'
import ky from 'ky'

/**
 * Fetches API key from the backend for Flower authentication
 */
export const getFlowerApiKey = async (cloudUrl: string): Promise<string | undefined> => {
  const response = await ky.post(`${cloudUrl}/flower/api-key`, { json: {} })
  const data = await response.json<{ api_key: string }>()
  return data.api_key
}

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

  // Set the base URL on the class (static property) - this is what the patch enables
  if (baseUrl) {
    FlowerIntelligence.baseUrl = baseUrl
  }

  const client = FlowerIntelligence.instance as unknown as FlowerClient

  if (apiKey) {
    client.apiKey = apiKey
  }

  client.remoteHandoff = remoteHandoff ?? true

  return client
}

export const createConfiguredFlowerClient = async (): Promise<FlowerClient> => {
  const cloudUrl = await getCloudUrl()
  const baseUrl = `${cloudUrl}/flower`

  const apiKey = await getFlowerApiKey(cloudUrl)

  const client = await createFlowerClient({
    baseUrl,
    remoteHandoff: true,
    apiKey,
  })

  console.log('created flower client', client.baseUrl)

  return client
}
