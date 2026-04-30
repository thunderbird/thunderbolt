/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './src/drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DB_FILE_NAME!,
  },
})
