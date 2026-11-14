/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import { t } from 'elysia'
import { createAdminRoutes } from '../admin-macro'
import {
  createScimConnection,
  retireScimConnection,
  revokeScimCredential,
  rotateScimCredential,
} from '../scim/connections'
import { createSsoConnection, retireSsoConnection, ssoProviderIdPattern } from '../sso-connections'
import { getConnection, listConnections } from './connections'
import { auditRefusals } from './route-helpers'

const id = t.String({ maxLength: 255 })
const connectionParams = t.Object({ connectionId: id })
const name = t.String({ minLength: 1, maxLength: 100 })
const expiresAt = t.Optional(t.Date())

/** A token is shown once: nothing may keep a copy of the response. */
const noStore = { 'cache-control': 'no-store' }

/**
 * SSO and SCIM connections. Responses never carry an SSO client secret or certificate; a SCIM
 * token appears only in the response that issues it.
 */
export const createConnectionAdminRoutes = (auth: Auth, database: typeof DbType) =>
  createAdminRoutes('connection-admin-routes', auth, database)
    .get('/admin/connections', async () => ({ items: await listConnections(database) }))
    .get('/admin/connections/:connectionId', ({ params }) => getConnection(auth, database, params.connectionId), {
      params: connectionParams,
    })
    .post(
      '/admin/connections/sso',
      async ({ body, user }) => {
        const connectionId = await auditRefusals(
          database,
          {
            action: 'connection.created',
            actorId: user.id,
            target: { type: 'identity_connection', id: body.identityConnectionId ?? body.providerId },
          },
          () => createSsoConnection(database, { ...body, createdBy: user.id }),
        )
        return getConnection(auth, database, connectionId)
      },
      {
        body: t.Object({
          name,
          providerId: t.String({ pattern: ssoProviderIdPattern }),
          protocol: t.Union([
            t.Object({
              oidc: t.Object({
                issuer: t.String({ minLength: 1, maxLength: 2048 }),
                clientId: t.String({ minLength: 1, maxLength: 512 }),
                clientSecret: t.String({ minLength: 1, maxLength: 4096 }),
                discoveryEndpoint: t.Optional(t.String({ maxLength: 2048 })),
              }),
            }),
            t.Object({
              saml: t.Object({
                entityId: t.String({ minLength: 1, maxLength: 2048 }),
                entryPoint: t.String({ minLength: 1, maxLength: 2048 }),
                cert: t.String({ minLength: 1, maxLength: 16384 }),
                idpIssuer: t.String({ minLength: 1, maxLength: 2048 }),
              }),
            }),
          ]),
          matchClaim: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
          identityConnectionId: t.Optional(id),
        }),
      },
    )
    .post(
      '/admin/connections/:connectionId/retire',
      async ({ params, user }) => {
        await auditRefusals(
          database,
          {
            action: 'connection.retired',
            actorId: user.id,
            target: { type: 'identity_connection', id: params.connectionId },
          },
          () => retireSsoConnection(database, { identityConnectionId: params.connectionId, actorId: user.id }),
        )
        return getConnection(auth, database, params.connectionId)
      },
      { params: connectionParams },
    )
    .post(
      '/admin/connections/scim',
      async ({ body, user, set }) => {
        const created = await auditRefusals(
          database,
          {
            action: 'connection.updated',
            actorId: user.id,
            target: {
              type: 'identity_connection',
              id: 'identityConnectionId' in body ? body.identityConnectionId : null,
            },
          },
          () => createScimConnection(auth, { ...body, actorId: user.id }),
        )
        Object.assign(set.headers, noStore)
        return created
      },
      {
        body: t.Union([
          t.Object({ name, expiresAt }, { additionalProperties: false }),
          t.Object({ identityConnectionId: id, expiresAt }, { additionalProperties: false }),
        ]),
      },
    )
    .post(
      '/admin/connections/:connectionId/scim/credentials',
      async ({ params, body, user, set }) => {
        const rotated = await rotateScimCredential(auth, {
          identityConnectionId: params.connectionId,
          actorId: user.id,
          expiresAt: body?.expiresAt,
        })
        Object.assign(set.headers, noStore)
        return rotated
      },
      { params: connectionParams, body: t.Optional(t.Object({ expiresAt })) },
    )
    .post(
      '/admin/connections/:connectionId/scim/credentials/:credentialId/revoke',
      async ({ params, user, set }) => {
        await revokeScimCredential(auth, {
          identityConnectionId: params.connectionId,
          credentialId: params.credentialId,
          actorId: user.id,
        })
        set.status = 204
      },
      { params: t.Object({ connectionId: id, credentialId: id }) },
    )
    .post(
      '/admin/connections/:connectionId/scim/retire',
      async ({ params, user, set }) => {
        await retireScimConnection(auth, { identityConnectionId: params.connectionId, actorId: user.id })
        set.status = 202
        return getConnection(auth, database, params.connectionId)
      },
      { params: connectionParams },
    )
