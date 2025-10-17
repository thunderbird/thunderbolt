import { getSettings } from '@/dal'

/**
 * Get the default cloud URL from environment variables or fallback to localhost
 * Includes /v1 API version prefix
 */
export const getDefaultCloudUrl = (): string => {
  return import.meta.env?.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000/v1'
}

/**
 * Get the cloud URL from settings or fallback to default
 */
export const getCloudUrl = async (): Promise<string> => {
  const settings = await getSettings({ cloud_url: getDefaultCloudUrl() })
  return settings.cloudUrl
}
