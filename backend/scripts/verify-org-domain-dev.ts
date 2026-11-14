/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Dev only: mark an org domain verified without DNS, for local test stacks whose domains
 * (`acme.test`) can't hold a TXT record. It runs the real `verifyOrgDomain`, with a resolver that
 * answers the domain's own token, so the row and its `domain.verified` event are what a real check
 * writes. Never part of the app: the backend image copies only `backend/src`, and
 * `deploy/docker/backend-image.test.ts` keeps it that way.
 *
 *   cd backend && bun --env-file=../e2e/keycloak/backend.env scripts/verify-org-domain-dev.ts <domain> <actor user id>
 */

import { db } from '@/db/client'
import { orgDomain } from '@/db/schema'
import { verificationRecordValue, verifyOrgDomain } from '@/identity/domains'
import { eq } from 'drizzle-orm'

const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Why this run is refused, or null: only a dev or test process against a local database may run it. */
const refusal = () => {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return `NODE_ENV is "${process.env.NODE_ENV ?? ''}"; this runs only in development or test`
  }
  const url = process.env.DATABASE_URL
  if (process.env.DATABASE_DRIVER === 'pglite') {
    return null
  }
  if (!url || !localHosts.has(new URL(url).hostname)) {
    return 'DATABASE_URL is not a local database'
  }
  return null
}

const [domain, actorId] = process.argv.slice(2)
const refused = refusal()
if (refused || !domain || !actorId) {
  console.error(refused ?? 'usage: verify-org-domain-dev.ts <domain> <actor user id>')
  process.exit(1)
}

const [row] = await db.select().from(orgDomain).where(eq(orgDomain.domain, domain))
if (!row) {
  console.error(`No org domain ${domain}; add it first with POST /v1/admin/domains`)
  process.exit(1)
}
const verified = await verifyOrgDomain(db, { domainId: row.id, actorId }, async () => [
  [verificationRecordValue(row.verificationToken)],
])
console.log(`${domain} verified at ${verified.verifiedAt?.toISOString()}`)
process.exit(0)
