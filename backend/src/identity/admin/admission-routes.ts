/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import { resolveEmailLocale } from '@/emails/i18n'
import { t } from 'elysia'
import { createAdminRoutes } from '../admin-macro'
import {
  addOrgDomain,
  claimOrgDomain,
  removeOrgDomain,
  setDomainEnrollment,
  unclaimOrgDomain,
  verifyOrgDomain,
} from '../domains'
import { createInvitation, revokeInvitation } from '../invitations/invitations'
import { getDomain, listDomains, listInvitations, toInvitationView } from './admission'
import { defaultAdminPageSize, pageQuery } from './pagination'
import { auditRefusals, timestampCursor } from './route-helpers'

const id = t.String({ maxLength: 255 })
const domainParams = t.Object({ domainId: id })

/**
 * Native admission: invitations and org domains. The invitation and enrollment services record
 * their own refusals; the claim and removal routes record theirs here.
 */
export const createAdmissionAdminRoutes = (auth: Auth, database: typeof DbType) =>
  createAdminRoutes('admission-admin-routes', auth, database)
    .get(
      '/admin/invitations',
      ({ query }) =>
        listInvitations(database, {
          status: query.status ?? 'pending',
          q: query.q,
          after: timestampCursor(query.cursor),
          limit: query.limit ?? defaultAdminPageSize,
        }),
      {
        query: t.Object({
          ...pageQuery,
          status: t.Optional(t.Union([t.Literal('pending'), t.Literal('accepted'), t.Literal('revoked')])),
          q: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        }),
      },
    )
    .post(
      '/admin/invitations',
      async ({ body, user, request }) =>
        toInvitationView(
          await createInvitation(database, {
            email: body.email,
            idpOverride: body.idpOverride,
            invitedBy: user.id,
            // The email goes out in the inviting admin's language.
            locale: resolveEmailLocale(request.headers.get('X-App-Language')),
          }),
        ),
      {
        body: t.Object({ email: t.String({ format: 'email', maxLength: 320 }), idpOverride: t.Optional(t.Boolean()) }),
      },
    )
    .post(
      '/admin/invitations/:invitationId/revoke',
      async ({ params, user, set }) => {
        await revokeInvitation(database, { invitationId: params.invitationId, revokedBy: user.id })
        set.status = 204
      },
      { params: t.Object({ invitationId: id }) },
    )
    .get('/admin/domains', async () => ({ items: await listDomains(database) }))
    .post(
      '/admin/domains',
      async ({ body, user }) => getDomain(database, (await addOrgDomain(database, { ...body, actorId: user.id })).id),
      { body: t.Object({ domain: t.String({ minLength: 1, maxLength: 253 }) }) },
    )
    .post(
      '/admin/domains/:domainId/verify',
      async ({ params, user }) => {
        await verifyOrgDomain(database, { domainId: params.domainId, actorId: user.id })
        return getDomain(database, params.domainId)
      },
      { params: domainParams },
    )
    .put(
      '/admin/domains/:domainId/enrollment',
      async ({ params, body, user }) => {
        await setDomainEnrollment(database, { domainId: params.domainId, enabled: body.enabled, actorId: user.id })
        return getDomain(database, params.domainId)
      },
      { params: domainParams, body: t.Object({ enabled: t.Boolean() }) },
    )
    .put(
      '/admin/domains/:domainId/claim',
      async ({ params, body, user }) => {
        await auditRefusals(
          database,
          { action: 'domain.claimed', actorId: user.id, target: { type: 'org_domain', id: params.domainId } },
          () => claimOrgDomain(database, { domainId: params.domainId, ...body, actorId: user.id }),
        )
        return getDomain(database, params.domainId)
      },
      { params: domainParams, body: t.Object({ identityConnectionId: id }) },
    )
    .delete(
      '/admin/domains/:domainId/claim',
      async ({ params, user }) => {
        await unclaimOrgDomain(database, { domainId: params.domainId, actorId: user.id })
        return getDomain(database, params.domainId)
      },
      { params: domainParams },
    )
    .delete(
      '/admin/domains/:domainId',
      async ({ params, user, set }) => {
        await auditRefusals(
          database,
          { action: 'domain.removed', actorId: user.id, target: { type: 'org_domain', id: params.domainId } },
          () => removeOrgDomain(database, { domainId: params.domainId, actorId: user.id }),
        )
        set.status = 204
      },
      { params: domainParams },
    )
