import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'

export const waitlist = pgTable(
  'waitlist',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    status: text('status', { enum: ['pending', 'approved'] })
      .notNull()
      .default('pending'),
    batchId: text('batch_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('waitlist_email_idx').on(table.email),
    index('waitlist_status_idx').on(table.status),
    index('waitlist_batch_id_idx').on(table.batchId),
  ],
)
