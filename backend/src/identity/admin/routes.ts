/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import { Elysia } from 'elysia'
import { createAdmissionAdminRoutes } from './admission-routes'
import { createConnectionAdminRoutes } from './connections-routes'
import { createGroupAdminRoutes } from './groups-routes'
import { createLinkReviewAdminRoutes } from './link-review-routes'
import { createMemberAdminRoutes } from './members-routes'

/**
 * The admin API under `/v1/admin`. Every route group builds on `createAdminRoutes`, which re-checks
 * the caller's admin role on each request and records a non-admin's attempt as `admin.access_denied`.
 */
export const createIdentityAdminRoutes = (auth: Auth, database: typeof DbType) =>
  new Elysia({ name: 'identity-admin-routes' })
    .use(createMemberAdminRoutes(auth, database))
    .use(createGroupAdminRoutes(auth, database))
    .use(createConnectionAdminRoutes(auth, database))
    .use(createAdmissionAdminRoutes(auth, database))
    .use(createLinkReviewAdminRoutes(auth, database))
