/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
  },
  (table) => [index('waitlist_status_idx').on(table.status), index('waitlist_batch_id_idx').on(table.batchId)],
)
