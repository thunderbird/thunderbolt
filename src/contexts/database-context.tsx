import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { createContext, useContext, type ReactNode } from 'react'

type DatabaseContextType = {
  db: AnyDrizzleDatabase
}

const DatabaseContext = createContext<DatabaseContextType | undefined>(undefined)

export const DatabaseProvider = ({ children, db }: { children: ReactNode; db: AnyDrizzleDatabase }) => {
  return <DatabaseContext.Provider value={{ db }}>{children}</DatabaseContext.Provider>
}

/** Access the Drizzle database instance from React components. */
export const useDatabase = () => {
  const context = useContext(DatabaseContext)
  if (!context) {
    throw new Error('useDatabase must be used within a DatabaseProvider')
  }
  return context.db
}
