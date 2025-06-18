import { DatabaseSingleton } from '@/db/singleton'

/**
 * Hook to get the database instance
 * This replaces the old useDrizzle hook
 */
export function useDatabase() {
  return {
    db: DatabaseSingleton.instance.db,
  }
}
