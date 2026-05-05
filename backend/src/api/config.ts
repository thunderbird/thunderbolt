/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { detectInsecureDefaultsForBackend } from '@/config/insecure-defaults-warning'
import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia } from 'elysia'

export const createConfigRoutes = (settings: Settings) =>
  new Elysia({ prefix: '/config' }).onError(safeErrorHandler).get('/', () => ({
    e2eeEnabled: settings.e2eeEnabled,
    // Names of well-known default credentials currently in use. Empty array
    // when secure (or when DANGEROUSLY_ALLOW_DEFAULT_CREDS=true). The frontend
    // surfaces this in the browser DevTools console — never the values, just
    // the env-var names — so anyone who opens DevTools sees a security alert.
    securityWarnings: detectInsecureDefaultsForBackend().map((m) => m.envKey),
  }))
