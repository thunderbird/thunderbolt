/**
 * Utilities for comparing database rows with default constants
 * to determine if users have modified defaults
 */

/**
 * Compare a DB row with its default to determine if user has modified it
 * Returns true if the row differs from default, false if identical
 */
export const hasUserModifications = <T extends { id: string }>(
  dbRow: T,
  defaults: ReadonlyArray<Partial<T>>,
): boolean => {
  const defaultItem = defaults.find((d) => d.id === dbRow.id)

  if (!defaultItem) {
    return false // User-created item, not a default
  }

  // Compare all fields that exist in the default
  for (const key in defaultItem) {
    if (dbRow[key] !== defaultItem[key]) {
      return true
    }
  }

  return false
}

/**
 * Get the default value for an item by ID
 */
export const getDefaultById = <T extends { id: string }>(id: string, defaults: ReadonlyArray<T>): T | undefined => {
  return defaults.find((d) => d.id === id)
}

/**
 * Check if an item is a default (exists in constants)
 */
export const isDefault = (id: string, defaults: ReadonlyArray<{ id: string }>): boolean => {
  return defaults.some((d) => d.id === id)
}
