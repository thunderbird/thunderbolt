import { integer, pgTable, varchar } from 'drizzle-orm/pg-core'

// Re-export Better Auth schema tables
export * from './auth-schema'

export const usersTable = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull(),
  age: integer().notNull(),
  email: varchar({ length: 255 }).notNull().unique(),
})
