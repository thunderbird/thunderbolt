import type { Settings } from '@/config/settings'

const MGMT_BASE_URL = 'https://api.flower.ai/v1'

/**
 * Request a Flower API key.
 *
 * @param userIdHash - Unique identifier for the user
 * @param expiresAt - Optional timestamp when the API key will become invalid
 * @param settings - Application settings
 * @returns The API key string
 */
export const getFlowerApiKey = async (userIdHash: string, expiresAt?: number, settings?: Settings): Promise<string> => {
  if (!settings) {
    throw new Error('Settings are required')
  }

  const payload: Record<string, string | number> = {
    billing_id: userIdHash,
  }

  if (expiresAt) {
    payload.expires_at = expiresAt
  }

  const mgmtUrl = getMgmtUrl(settings)
  const headers = getHeaders(settings)

  try {
    const response = await fetch(mgmtUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Error when requesting Flower API key: ${response.status} ${errorText}`)
    }

    const data = (await response.json()) as { api_key: string }

    if (!data.api_key) {
      throw new Error('Bad response from Flower API server')
    }

    return data.api_key
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Error when requesting Flower API key: ${error.message}`)
    }
    throw new Error('Unknown error when requesting Flower API key')
  }
}

/**
 * Get the management URL for Flower API
 */
const getMgmtUrl = (settings: Settings): string => {
  const projectId = settings.flowerProjId
  if (!projectId) {
    throw new Error('FLOWER_PROJ_ID must be set in environment variables')
  }

  return `${MGMT_BASE_URL}/organization/projects/${projectId}/api_keys`
}

/**
 * Get the headers for Flower API requests
 */
const getHeaders = (settings: Settings): Record<string, string> => {
  const mgmtKey = settings.flowerMgmtKey
  if (!mgmtKey) {
    throw new Error('FLOWER_MGMT_KEY must be set in environment variables')
  }

  return {
    Authorization: `Bearer ${mgmtKey}`,
  }
}
