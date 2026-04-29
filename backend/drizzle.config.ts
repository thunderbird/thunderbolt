/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  casing: 'snake_case',
  driver: process.env.DATABASE_DRIVER === 'pglite' ? 'pglite' : undefined,
  dbCredentials: {
    database: 'postgres',
    url: process.env.DATABASE_URL!,
  },
})
