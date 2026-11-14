/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType, QueryableDatabase } from '@/db/client'
import { orgDomain } from '@/db/schema'
import { Resolver } from 'node:dns/promises'
import { domainToASCII } from 'node:url'
import { and, eq } from 'drizzle-orm'
import type { AuthAdapter } from './access'
import { AdmissionError } from './admission-error'
import { insertAuditEvent, recordFailedAttempt } from './audit/write'
import { getCurrentOrganizationId } from './current-organization'

/** What admission reads from an `org_domain` row. */
export type OrgDomainRow = {
  id: string
  domain: string
  verifiedAt: Date | null
  enrollmentEnabled: boolean
  claimedByConnectionId: string | null
}

export type ResolveTxt = (hostname: string) => Promise<string[][]>

export type DomainCheckError = 'TXT_RECORD_NOT_FOUND' | 'TXT_RECORD_MISMATCH' | 'DNS_LOOKUP_FAILED'

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Normalize a domain for storage and comparison: trimmed, lowercased, IDNA (punycode) and without
 * a trailing dot. Null for anything that isn't a hostname with at least two labels, IP literals
 * and wildcards included.
 */
export const normalizeDomain = (input: string) => {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, '')
  // `domainToASCII` parses like a URL host and would quietly drop a userinfo or path part.
  if (/[\s@/\\:?#%*]/.test(trimmed)) {
    return null
  }
  const domain = domainToASCII(trimmed)
  const labels = domain.split('.')
  const valid = labels.length >= 2 && labels.every((label) => dnsLabel.test(label)) && !/^\d+$/.test(labels.at(-1)!)
  return valid ? domain : null
}

/** The normalized domain of an email address, or null when it has none. */
export const emailDomain = (email: string) => normalizeDomain(email.slice(email.lastIndexOf('@') + 1))

/** Whether an IdP connection claims the domain. A claimed domain is closed to every local way in but an overridden invitation. */
export const isClaimedDomain = (row: OrgDomainRow | null | undefined) => Boolean(row?.claimedByConnectionId)

/** Whether a person who verifies an address on this domain may join without an invitation. */
export const isEnrollableDomain = (row: OrgDomainRow | null | undefined) =>
  Boolean(row?.verifiedAt && row.enrollmentEnabled && !isClaimedDomain(row))

/** The current org's row for an email address's domain, through the auth adapter. Exact match: a subdomain never matches its parent. */
export const findOrgDomainForEmail = async (adapter: AuthAdapter, email: string) => {
  const domain = emailDomain(email)
  if (!domain) {
    return null
  }
  return adapter.findOne<OrgDomainRow>({
    model: 'orgDomain',
    where: [
      { field: 'orgId', value: getCurrentOrganizationId() },
      { field: 'domain', value: domain },
    ],
  })
}

/** `findOrgDomainForEmail` through Drizzle, for callers outside Better Auth's hooks. */
export const getOrgDomainForEmail = async (database: QueryableDatabase, email: string) => {
  const domain = emailDomain(email)
  if (!domain) {
    return null
  }
  const [row] = await database
    .select()
    .from(orgDomain)
    .where(and(eq(orgDomain.orgId, getCurrentOrganizationId()), eq(orgDomain.domain, domain)))
  return row ?? null
}

/** The DNS name that must hold a domain's verification record. */
export const verificationRecordName = (domain: string) => `_thunderbolt-verification.${domain}`

/** The TXT record value that proves control of a domain. */
export const verificationRecordValue = (token: string) => `thunderbolt-verification=${token}`

const resolver = new Resolver({ timeout: 5000, tries: 2 })

const systemResolveTxt: ResolveTxt = (hostname) => resolver.resolveTxt(hostname)

/** Look for the verification record. Null when it is there; the reason otherwise. */
const checkVerificationRecord = async (
  row: { domain: string; verificationToken: string },
  resolveTxt: ResolveTxt,
): Promise<DomainCheckError | null> => {
  const expected = verificationRecordValue(row.verificationToken)
  try {
    const records = await resolveTxt(verificationRecordName(row.domain))
    return records.some((chunks) => chunks.join('') === expected) ? null : 'TXT_RECORD_MISMATCH'
  } catch (error) {
    const code = (error as { code?: string }).code
    return code === 'ENOTFOUND' || code === 'ENODATA' ? 'TXT_RECORD_NOT_FOUND' : 'DNS_LOOKUP_FAILED'
  }
}

const getOrgDomain = async (database: QueryableDatabase, domainId: string) => {
  const [row] = await database
    .select()
    .from(orgDomain)
    .where(and(eq(orgDomain.orgId, getCurrentOrganizationId()), eq(orgDomain.id, domainId)))
  if (!row) {
    throw new AdmissionError('DOMAIN_NOT_FOUND')
  }
  return row
}

/**
 * Add a domain to the current org, unverified and closed to enrollment. The returned row's
 * `verificationToken` goes in a TXT record at `verificationRecordName(domain)`.
 */
export const addOrgDomain = async (
  database: typeof DbType,
  { domain, actorId }: { domain: string; actorId: string },
) => {
  const normalized = normalizeDomain(domain)
  if (!normalized) {
    throw new AdmissionError('INVALID_DOMAIN')
  }
  return database.transaction(async (tx) => {
    const [row] = await tx
      .insert(orgDomain)
      .values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        domain: normalized,
        verificationToken: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
        createdBy: actorId,
      })
      .returning()
    await insertAuditEvent(tx, {
      action: 'domain.added',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'org_domain', id: row.id },
      metadata: { domain: normalized },
    })
    return row
  })
}

/**
 * Check a domain's DNS verification record and record the result. A domain verified once stays
 * verified; a later failed check only records its error. Pass `resolveTxt` in tests.
 */
export const verifyOrgDomain = async (
  database: typeof DbType,
  { domainId, actorId }: { domainId: string; actorId: string },
  resolveTxt: ResolveTxt = systemResolveTxt,
) => {
  const row = await getOrgDomain(database, domainId)
  const error = await checkVerificationRecord(row, resolveTxt)
  const now = new Date()
  return database.transaction(async (tx) => {
    const [updated] = await tx
      .update(orgDomain)
      .set({
        lastCheckedAt: now,
        lastCheckError: error,
        verifiedAt: error ? row.verifiedAt : (row.verifiedAt ?? now),
      })
      .where(eq(orgDomain.id, row.id))
      .returning()
    await insertAuditEvent(tx, {
      action: 'domain.verified',
      outcome: error ? 'failure' : 'success',
      reason: error,
      actor: { type: 'user', id: actorId },
      target: { type: 'org_domain', id: row.id },
      metadata: { domain: row.domain },
    })
    return updated
  })
}

/** Why a domain can't be opened to enrollment, or null when it can. */
const enrollmentRefusal = (row: OrgDomainRow) => {
  if (!row.verifiedAt) {
    return 'DOMAIN_NOT_VERIFIED'
  }
  return isClaimedDomain(row) ? 'DOMAIN_CLAIMED_BY_IDP' : null
}

/**
 * Open or close a domain to enrollment. Only a verified domain that no IdP connection claims can
 * be opened; refusing either is audited. Members who join by domain always get the ordinary
 * member role.
 */
export const setDomainEnrollment = async (
  database: typeof DbType,
  { domainId, enabled, actorId }: { domainId: string; enabled: boolean; actorId: string },
) => {
  const row = await getOrgDomain(database, domainId)
  const refusal = enabled ? enrollmentRefusal(row) : null
  if (refusal) {
    await recordFailedAttempt(database, {
      action: 'admission_policy.updated',
      outcome: 'denied',
      reason: refusal,
      actor: { type: 'user', id: actorId },
      target: { type: 'org_domain', id: row.id },
      connectionId: row.claimedByConnectionId,
      changes: { enrollmentEnabled: { from: row.enrollmentEnabled, to: enabled } },
    })
    throw new AdmissionError(refusal)
  }
  return database.transaction(async (tx) => {
    const [updated] = await tx
      .update(orgDomain)
      .set({ enrollmentEnabled: enabled })
      .where(eq(orgDomain.id, row.id))
      .returning()
    await insertAuditEvent(tx, {
      action: 'admission_policy.updated',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'org_domain', id: row.id },
      changes: { enrollmentEnabled: { from: row.enrollmentEnabled, to: enabled } },
    })
    return updated
  })
}
