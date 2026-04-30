/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia } from 'elysia'

export const createConfigRoutes = (settings: Settings) =>
  new Elysia({ prefix: '/config' }).onError(safeErrorHandler).get('/', () => ({
    e2eeEnabled: settings.e2eeEnabled,
  }))
