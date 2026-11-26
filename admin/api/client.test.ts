/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { createClient } from '@/lib/http'
import { describe, expect, it, mock } from 'bun:test'
import { AdminApiError, createAdminApi } from './client'

type Reply = { status?: number; body?: unknown }

/** An admin API on a fake backend that records each request and answers with `reply`. */
const setup = (reply: Reply = {}) => {
  const requests: Request[] = []
  const http = createClient({
    prefixUrl: 'http://backend.test/v1',
    fetch: async (input) => {
      requests.push(input as Request)
      const status = reply.status ?? 200
      return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), { status })
    },
  })
  const onAdminRequired = mock(() => {})
  return { api: createAdminApi(http, { onAdminRequired }), requests, onAdminRequired }
}

describe('createAdminApi', () => {
  it('sends each call to its route with its body and query', async () => {
    const { api, requests } = setup({ body: { items: [], nextCursor: null } })
    await api.members.list({ q: 'ada', cursor: 'c1' })
    await api.members.update('u/1', { name: 'Ada' })
    await api.domains.setEnrollment('d1', true)
    await api.roleMappings.create({ localGroupId: 'g1', role: 'admin' })

    const [list, update, enrollment, mapping] = requests
    expect(list.method).toBe('GET')
    expect(list.url).toBe('http://backend.test/v1/admin/members?cursor=c1&q=ada')
    expect(update.method).toBe('PATCH')
    expect(update.url).toBe('http://backend.test/v1/admin/members/u%2F1')
    expect(await update.json()).toEqual({ name: 'Ada' })
    expect(enrollment.method).toBe('PUT')
    expect(await enrollment.json()).toEqual({ enabled: true })
    expect(await mapping.json()).toEqual({ localGroupId: 'g1', role: 'admin' })
  })

  it('sends no q for a cleared member search', async () => {
    const { api, requests } = setup({ body: { items: [], nextCursor: null } })
    await api.members.list({ q: '' })
    expect(new URL(requests[0].url).searchParams.has('q')).toBe(false)
  })

  it('sends an invitation expiry filter, and no q for a cleared link-review search', async () => {
    const invitations = setup({ body: { items: [], nextCursor: null } })
    await invitations.api.invitations.list({ status: 'pending', expired: false })
    expect(new URL(invitations.requests[0].url).searchParams.get('expired')).toBe('false')
    const reviews = setup({ body: { reviews: [], nextCursor: null } })
    await reviews.api.linkReviews.list({ q: '' })
    expect(new URL(reviews.requests[0].url).searchParams.has('q')).toBe(false)
  })

  it('returns audit events and link reviews as pages', async () => {
    const event = { id: 'e1' }
    const events = await setup({ body: { events: [event], nextCursor: 'n' } }).api.auditEvents.list()
    expect(events).toMatchObject({ items: [event], nextCursor: 'n' })
    const one = setup({ body: event })
    expect(await one.api.auditEvents.get('e/1')).toMatchObject(event)
    expect(new URL(one.requests[0].url).pathname).toBe('/v1/admin/audit-events/e%2F1')
    expect(await setup({ body: { reviews: [], nextCursor: null } }).api.linkReviews.list()).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it('unwraps the lists that have no cursor', async () => {
    expect(await setup({ body: { items: [{ id: 'd1' }] } }).api.domains.list()).toMatchObject([{ id: 'd1' }])
  })

  it('accepts an empty 204 answer', async () => {
    await expect(setup({ status: 204 }).api.members.purge('u1')).resolves.toBeUndefined()
  })

  it('throws the API error code', async () => {
    const { api, onAdminRequired } = setup({ status: 409, body: { code: 'GROUP_NAME_TAKEN' } })
    const error = await api.groups.create({ name: 'Ops' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AdminApiError)
    expect(error).toMatchObject({ status: 409, code: 'GROUP_NAME_TAKEN' })
    expect(onAdminRequired).not.toHaveBeenCalled()
  })

  it('reports a lost admin role so the session can be read again', async () => {
    const { api, onAdminRequired } = setup({ status: 403, body: { code: 'ADMIN_REQUIRED' } })
    await expect(api.breakGlass.get()).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' })
    expect(onAdminRequired).toHaveBeenCalledTimes(1)
  })

  it('carries the field an SSO edit refused', async () => {
    const { api } = setup({ status: 409, body: { code: 'SSO_IDENTITY_FIELD_LOCKED', field: 'clientId' } })
    await expect(api.connections.update('c1', { oidc: { clientId: 'x' } })).rejects.toMatchObject({
      code: 'SSO_IDENTITY_FIELD_LOCKED',
      field: 'clientId',
    })
  })

  it('falls back to the status for a response without a code', async () => {
    await expect(setup({ status: 500, body: 'nope' }).api.breakGlass.get()).rejects.toMatchObject({ code: '500' })
  })
})
