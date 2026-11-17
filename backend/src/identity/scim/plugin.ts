/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { scim } from '@better-auth/scim'
import type { BetterAuthPlugin } from 'better-auth'
import { hkdfSync } from 'node:crypto'
import { createScimLifecycle } from './lifecycle'
import { scimProjection } from './projection'
import { scimRequestScope } from './request-scope'

/** Better Auth's path prefix for every SCIM route, as hooks see it. */
const scimEndpointPrefix = '/scim/v2/'

const credentialHashInfo = 'thunderbolt/scim-credential-hash/v1'

/**
 * The HMAC secret the SCIM plugin digests managed tokens with, derived from `BETTER_AUTH_SECRET`
 * so operators have no extra secret to set. Rotating `BETTER_AUTH_SECRET` invalidates every SCIM
 * token.
 */
export const deriveScimCredentialHashSecret = (betterAuthSecret: string) =>
  Buffer.from(hkdfSync('sha256', betterAuthSecret, '', credentialHashInfo, 32)).toString('base64url')

const isScimEndpoint = (path: string | undefined) => path?.startsWith(scimEndpointPrefix) ?? false

/**
 * The IdP vouches for the addresses it provisions, so a SCIM-created user and a SCIM email change
 * leave the Better Auth email verified. The plugin itself resets the flag on every email change.
 */
export const scimEmailVerified = () =>
  ({
    id: 'scim-email-verified',
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              before: async (user, context) =>
                isScimEndpoint(context?.path) ? { data: { ...user, emailVerified: true } } : undefined,
            },
            update: {
              before: async (data, context) =>
                isScimEndpoint(context?.path) && data.email !== undefined
                  ? { data: { ...data, emailVerified: true } }
                  : undefined,
            },
          },
        },
      },
    }),
  }) satisfies BetterAuthPlugin

/**
 * Inbound SCIM 2.0, at `/v1/api/auth/scim/v2`. Connections are only the managed ones an admin
 * creates (`connections.ts`), so without an active connection's token every resource route is a
 * 401. Requests reach the plugin through `createScimRequestHandler`, never directly.
 */
export const buildScimPlugins = (settings: Pick<Settings, 'betterAuthSecret'>, database: typeof DbType) => [
  scim({
    connections: [],
    managedConnections: { credentialHashSecret: deriveScimCredentialHashSecret(settings.betterAuthSecret) },
    compatibility: { microsoftEntra: { acceptLegacyGroupSchema: true } },
    identity: createScimLifecycle(database),
    projection: scimProjection,
  }),
  scimEmailVerified(),
  scimRequestScope(),
]
