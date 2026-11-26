/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Elysia, type AnyElysia } from 'elysia'
import type { Auth } from './elysia-plugin'
import { createIntegrationOAuthRoutes } from './integration-oauth'

/** Google uses the same bounded token relay and authorization policy as other integrations. */
export const createGoogleAuthRoutes = (
  auth: Auth,
  fetchFn: typeof fetch = globalThis.fetch,
  rateLimit: AnyElysia = new Elysia(),
) => createIntegrationOAuthRoutes('google', auth, fetchFn, rateLimit)
