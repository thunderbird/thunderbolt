/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { auditEvent, identityConnection, orgDomain, user } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getCurrentOrganizationId } from './current-organization'
import {
  addOrgDomain,
  emailDomain,
  normalizeDomain,
  type ResolveTxt,
  setDomainEnrollment,
  testDnsServers,
  verificationRecordName,
  verificationRecordValue,
  verifyOrgDomain,
} from './domains'

describe('normalizeDomain', () => {
  it('lowercases, trims, drops a trailing dot and encodes IDNA', () => {
    expect(normalizeDomain(' Corp.Example. ')).toBe('corp.example')
    expect(normalizeDomain('Bücher.de')).toBe('xn--bcher-kva.de')
  })

  it('rejects anything that is not a hostname with two labels', () => {
    for (const input of ['corp', '*.corp.com', 'a@corp.com', 'corp.com/x', '1.2.3.4', 'corp..com', '-corp.com', '']) {
      expect(normalizeDomain(input)).toBeNull()
    }
  })
})

describe('emailDomain', () => {
  it('takes the part after the last @, normalized', () => {
    expect(emailDomain('A@Corp.COM')).toBe('corp.com')
    expect(emailDomain('"odd@quoted"@corp.com')).toBe('corp.com')
    expect(emailDomain('nobody')).toBeNull()
  })
})

describe('testDnsServers', () => {
  const saved = { nodeEnv: process.env.NODE_ENV, servers: process.env.TEST_DNS_SERVERS }

  afterEach(() => {
    process.env.NODE_ENV = saved.nodeEnv
    if (saved.servers === undefined) {
      delete process.env.TEST_DNS_SERVERS
    } else {
      process.env.TEST_DNS_SERVERS = saved.servers
    }
  })

  it('is ignored outside tests', () => {
    process.env.NODE_ENV = 'production'
    process.env.TEST_DNS_SERVERS = '127.0.0.1:9884'
    expect(testDnsServers()).toEqual([])
  })

  it('is ignored when unset', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.TEST_DNS_SERVERS
    expect(testDnsServers()).toEqual([])
  })

  it('names the servers while the backend runs tests', () => {
    process.env.NODE_ENV = 'test'
    process.env.TEST_DNS_SERVERS = '127.0.0.1:9884,127.0.0.1:9886'
    expect(testDnsServers()).toEqual(['127.0.0.1:9884', '127.0.0.1:9886'])
  })
})

describe('org domain service', () => {
  let db: typeof DbType
  let cleanup: () => Promise<void>
  const actorId = 'admin-user'

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
    await db.insert(user).values({ id: actorId, name: 'Admin', email: 'admin@corp.com', emailVerified: true })
  })

  afterEach(async () => {
    await cleanup()
  })

  const resolvingTo =
    (records: string[][]): ResolveTxt =>
    async () =>
      records

  const failingWith =
    (code: string): ResolveTxt =>
    async () => {
      throw Object.assign(new Error(code), { code })
    }

  const auditOf = (action: string) => db.select().from(auditEvent).where(eq(auditEvent.action, action))

  it('adds a normalized domain, unverified and closed, with a random token', async () => {
    const row = await addOrgDomain(db, { domain: 'Corp.COM', actorId })

    expect(row).toMatchObject({ domain: 'corp.com', verifiedAt: null, enrollmentEnabled: false, createdBy: actorId })
    expect(row.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await auditOf('domain.added')).toMatchObject([{ outcome: 'success', actorId, targetId: row.id }])
  })

  it('refuses an invalid domain', async () => {
    await expect(addOrgDomain(db, { domain: '*.corp.com', actorId })).rejects.toMatchObject({ code: 'INVALID_DOMAIN' })
  })

  it('verifies when the TXT record holds the token, also when split into chunks', async () => {
    const row = await addOrgDomain(db, { domain: 'corp.com', actorId })
    const value = verificationRecordValue(row.verificationToken)
    const lookedUp: string[] = []
    const resolveTxt: ResolveTxt = async (hostname) => {
      lookedUp.push(hostname)
      return [['v=spf1 -all'], [value.slice(0, 20), value.slice(20)]]
    }

    const verified = await verifyOrgDomain(db, { domainId: row.id, actorId }, resolveTxt)

    expect(lookedUp).toEqual([verificationRecordName('corp.com')])
    expect(lookedUp[0]).toBe('_thunderbolt-verification.corp.com')
    expect(verified.verifiedAt).toBeInstanceOf(Date)
    expect(verified.lastCheckError).toBeNull()
    expect(await auditOf('domain.verified')).toMatchObject([{ outcome: 'success', targetId: row.id }])
  })

  it('records why a check failed and leaves the domain unverified', async () => {
    const row = await addOrgDomain(db, { domain: 'corp.com', actorId })

    for (const [resolveTxt, error] of [
      [resolvingTo([['thunderbolt-verification=wrong']]), 'TXT_RECORD_MISMATCH'],
      [failingWith('ENOTFOUND'), 'TXT_RECORD_NOT_FOUND'],
      [failingWith('ENODATA'), 'TXT_RECORD_NOT_FOUND'],
      [failingWith('ETIMEOUT'), 'DNS_LOOKUP_FAILED'],
    ] as const) {
      const checked = await verifyOrgDomain(db, { domainId: row.id, actorId }, resolveTxt)
      expect(checked).toMatchObject({ verifiedAt: null, lastCheckError: error })
      expect(checked.lastCheckedAt).toBeInstanceOf(Date)
    }
    // The four checks can land in one millisecond, so their events have no reliable order.
    expect((await auditOf('domain.verified')).map((event) => `${event.outcome} ${event.reason}`).sort()).toEqual([
      'failure DNS_LOOKUP_FAILED',
      'failure TXT_RECORD_MISMATCH',
      'failure TXT_RECORD_NOT_FOUND',
      'failure TXT_RECORD_NOT_FOUND',
    ])
  })

  it('keeps a verified domain verified when a later check fails', async () => {
    const row = await addOrgDomain(db, { domain: 'corp.com', actorId })
    const first = await verifyOrgDomain(
      db,
      { domainId: row.id, actorId },
      resolvingTo([[verificationRecordValue(row.verificationToken)]]),
    )

    const second = await verifyOrgDomain(db, { domainId: row.id, actorId }, failingWith('ENOTFOUND'))

    expect(second.verifiedAt).toEqual(first.verifiedAt)
    expect(second.lastCheckError).toBe('TXT_RECORD_NOT_FOUND')
  })

  it('opens enrollment only on a verified, unclaimed domain, and audits the change', async () => {
    const row = await addOrgDomain(db, { domain: 'corp.com', actorId })
    await expect(setDomainEnrollment(db, { domainId: row.id, enabled: true, actorId })).rejects.toMatchObject({
      code: 'DOMAIN_NOT_VERIFIED',
    })

    await db.update(orgDomain).set({ verifiedAt: new Date() }).where(eq(orgDomain.id, row.id))
    const opened = await setDomainEnrollment(db, { domainId: row.id, enabled: true, actorId })
    expect(opened.enrollmentEnabled).toBe(true)
    expect((await auditOf('admission_policy.updated')).filter((event) => event.outcome === 'success')).toMatchObject([
      { targetId: row.id, changes: { enrollmentEnabled: { from: false, to: true } } },
    ])

    await db.insert(identityConnection).values({ id: 'entra', orgId: getCurrentOrganizationId(), name: 'Entra' })
    await db.update(orgDomain).set({ claimedByConnectionId: 'entra' }).where(eq(orgDomain.id, row.id))
    await expect(setDomainEnrollment(db, { domainId: row.id, enabled: true, actorId })).rejects.toMatchObject({
      code: 'DOMAIN_CLAIMED_BY_IDP',
    })
    expect((await setDomainEnrollment(db, { domainId: row.id, enabled: false, actorId })).enrollmentEnabled).toBe(false)
    expect((await auditOf('admission_policy.updated')).filter((event) => event.outcome === 'denied')).toMatchObject([
      { reason: 'DOMAIN_NOT_VERIFIED', actorId, targetId: row.id },
      { reason: 'DOMAIN_CLAIMED_BY_IDP', actorId, targetId: row.id, connectionId: 'entra' },
    ])
  })

  it('does not find a domain of another id', async () => {
    await expect(verifyOrgDomain(db, { domainId: 'missing', actorId }, resolvingTo([]))).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
    })
  })
})
