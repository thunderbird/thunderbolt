/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { configuredSsoProviderId } from '@/auth/paths'
import type { db as DbType } from '@/db/client'
import { orgMembership, organization } from '@/db/schema'
import { eq, sql } from 'drizzle-orm'
import { insertAuditEvent } from './audit/write'
import { implicitOrganizationId } from './current-organization'

/**
 * Create the implicit organization if it doesn't exist yet and, in the same transaction, give
 * every existing non-anonymous user an active membership. Runs at boot, after migrations.
 *
 * The backfill runs only on the call that creates the org. Re-running it on every boot would
 * silently admit any user created by a path that skipped admission. Each backfilled source
 * records how the user most likely got in: an SSO account, an approved waitlist row, or neither
 * (accounts that predate the waitlist).
 */
export const ensureImplicitOrganization = async (database: typeof DbType) =>
  database.transaction(async (tx) => {
    const created = await tx
      .insert(organization)
      .values({ id: implicitOrganizationId, name: 'Default', slug: implicitOrganizationId })
      .onConflictDoNothing()
      .returning()
    if (created.length === 0) {
      return
    }

    await tx.execute(sql`
      insert into org_membership (id, org_id, user_id)
      select gen_random_uuid()::text, ${implicitOrganizationId}, u.id
      from "user" u
      where u.is_anonymous = false
    `)
    await tx.execute(sql`
      insert into membership_source (id, org_id, membership_id, kind, ref)
      select
        gen_random_uuid()::text,
        m.org_id,
        m.id,
        case
          when exists (select 1 from account a where a.user_id = m.user_id and a.provider_id = ${configuredSsoProviderId})
            then 'sso'
          when w.id is not null then 'waitlist'
          else 'open'
        end,
        case
          when exists (select 1 from account a where a.user_id = m.user_id and a.provider_id = ${configuredSsoProviderId})
            then null
          else w.id
        end
      from org_membership m
      join "user" u on u.id = m.user_id
      left join waitlist w on w.email = u.email and w.status = 'approved'
      where m.org_id = ${implicitOrganizationId}
    `)

    const backfilled = await tx.$count(orgMembership, eq(orgMembership.orgId, implicitOrganizationId))
    await insertAuditEvent(tx, {
      action: 'member.admitted',
      outcome: 'success',
      actor: { type: 'system' },
      target: { type: 'organization', id: implicitOrganizationId },
      metadata: { backfilled },
    })
  })
