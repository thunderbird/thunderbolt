/**
 * Utility functions for converting values between their typed representation
 * and their string storage format using JSON, with special handling for strings
 * to avoid extra quotes.
 */

/**
 * Serialize a typed value to a string for storage
 * Uses JSON.stringify but removes quotes from strings for cleaner storage
 */
export const serializeValue = (value: any): string | null => {
  if (value === null) return null

  const json = JSON.stringify(value)

  // Remove quotes from strings for cleaner database storage
  if (json.startsWith('"') && json.endsWith('"')) {
    return json.slice(1, -1)
  }

  return json
}

/**
 * Deserialize a stored string value to its typed representation
 * Uses JSON.parse but handles unquoted strings gracefully
 */
export const deserializeValue = (value: string | null | undefined): any => {
  if (value === null || value === undefined) return null

  // Try parsing as JSON first (handles booleans, numbers, objects, arrays)
  try {
    return JSON.parse(value)
  } catch {
    // If it fails, it's an unquoted string - return as-is
    return value
  }
}
