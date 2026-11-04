/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from '@/db/database'
import { applySchema } from '@/db/apply-schema'
import { createClient } from '@/lib/http'
import { createCloudOfflineStore } from './offline'
import { createCloudAgentClient } from './client'

const submission = {
  commandId: 'message-command',
  keyEpoch: 1,
  content: { version: 1 as const, kind: 'scoped-payload' as const, iv: 'opaque-iv', ciphertext: 'opaque-ciphertext' },
}

describe('persistent cloud command transport', () => {
  const database = new Database()
  beforeEach(async () => {
    await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
    await applySchema(database.db)
  })
  afterEach(async () => {
    await database.close()
  })

  it('reuses a new agent’s persisted save instead of minting another outbox command after response loss', async () => {
    const bodies: string[] = []
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (input) => {
        bodies.push(await (input as Request).text())
        throw new TypeError('Response lost')
      },
    })
    const store = createCloudOfflineStore(database.db, 'owner')
    const client = createCloudAgentClient(http, 'owner', store)
    const envelope = {
      version: 1 as const,
      kind: 'resource-key' as const,
      recipientKeyId: 'owner',
      ephemeralPublicKey: 'opaque',
      mlkemCiphertext: 'opaque',
      iv: 'opaque',
      ciphertext: 'opaque',
    }
    const input = {
      id: 'stable-agent',
      expectedVersion: 0,
      keyEpoch: 1,
      enabled: true,
      config: submission.content,
      ownerKeyEnvelope: envelope,
      runtimeKeyEnvelope: envelope,
    }
    await expect(client.submitAgent(input)).rejects.toThrow('Response lost')
    const commandId = (await store.entries())[0].id
    await expect(client.submitAgent(input)).rejects.toThrow('Response lost')
    expect(await store.entries()).toHaveLength(1)
    expect((await store.entries())[0].id).toBe(commandId)
    expect(bodies[1]).toBe(bodies[0])
  })

  it('uses the mounted schedule create/update route with an exact prepared payload on every retry', async () => {
    const requests: { path: string; body: string }[] = []
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (input) => {
        const request = input as Request
        requests.push({ path: new URL(request.url).pathname, body: await request.text() })
        if (requests.length === 1) {
          throw new TypeError('Response lost')
        }
        return Response.json({ id: 'schedule' })
      },
    })
    const client = createCloudAgentClient(http, 'owner', createCloudOfflineStore(database.db, 'owner'))
    const create = {
      id: 'schedule',
      agentId: 'agent',
      keyEpoch: 1,
      enabled: true,
      expectedVersion: 0,
      config: submission.content,
    }
    await expect(client.submitSchedule(create)).rejects.toThrow('Response lost')
    await client.submitSchedule(create)
    await client.submitSchedule({ ...create, expectedVersion: 1, enabled: false })
    expect(requests.map((request) => request.path)).toEqual(
      Array(3).fill('/v1/cloud-agents/agents/agent/schedules/schedule'),
    )
    expect(requests[1].body).toBe(requests[0].body)
    expect(JSON.parse(requests[2].body)).toMatchObject({ id: 'schedule', expectedVersion: 1, enabled: false })
  })

  it('sends prepared connection, artifact and conversation IDs through their mounted endpoints', async () => {
    const requests: { path: string; body: unknown }[] = []
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (input) => {
        const request = input as Request
        requests.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({ id: 'saved' })
      },
    })
    const client = createCloudAgentClient(http, 'owner', createCloudOfflineStore(database.db, 'owner'))
    const envelope = {
      version: 1 as const,
      kind: 'resource-key' as const,
      recipientKeyId: 'owner',
      ephemeralPublicKey: 'opaque',
      mlkemCiphertext: 'opaque',
      iv: 'opaque',
      ciphertext: 'opaque',
    }
    const connection = {
      id: 'connection',
      expectedVersion: 0,
      keyEpoch: 1,
      enabled: true,
      config: submission.content,
      ownerKeyEnvelope: envelope,
      runtimeKeyEnvelope: envelope,
    }
    await client.submitConnection(connection)
    await client.submitConnection({ ...connection, expectedVersion: 1 })
    const artifact = {
      artifactId: 'artifact',
      body: {
        id: 'revision',
        parentRevisionId: 'parent',
        keyEpoch: 1,
        manifest: submission.content,
        content: submission.content,
      },
    }
    await client.submitArtifact(artifact)
    await client.submitArtifact(artifact)
    await client.createConversation('agent', 'conversation')
    await client.createConversation('agent', 'conversation')
    expect(requests.map((request) => request.path)).toEqual([
      '/v1/cloud-agents/connections',
      '/v1/cloud-agents/connections/connection',
      '/v1/cloud-agents/artifacts/artifact/revisions',
      '/v1/cloud-agents/artifacts/artifact/revisions',
      '/v1/cloud-agents/agents/agent/conversations',
      '/v1/cloud-agents/agents/agent/conversations',
    ])
    expect(requests[2].body).toEqual(artifact.body)
    expect(requests[3].body).toEqual(requests[2].body)
    expect(requests[4].body).toEqual({ id: 'conversation' })
    expect(requests[5].body).toEqual(requests[4].body)
  })

  it('starts OAuth for the saved cloud connection without adding a replayable command', async () => {
    const requests: Request[] = []
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (input) => {
        requests.push(input as Request)
        return Response.json({
          authorizationUrl: 'https://mcp.test/authorize?state=nonce',
          expiresAt: '2026-10-24T00:00:00Z',
        })
      },
    })
    const store = createCloudOfflineStore(database.db, 'owner')
    const result = await createCloudAgentClient(http, 'owner', store).startConnectionOAuth('saved-connection')
    expect(requests[0].url).toBe('https://cloud.test/v1/cloud-agents/connections/saved-connection/oauth/start')
    expect(requests[0].method).toBe('POST')
    expect(await requests[0].json()).toEqual({})
    expect(result.authorizationUrl).toStartWith('https://mcp.test/')
    expect(await store.entries()).toEqual([])
  })

  it('rejects an executable authorization URL before the browser opener can receive it', async () => {
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async () => Response.json({ authorizationUrl: 'javascript:alert(1)', expiresAt: 'later' }),
    })
    const client = createCloudAgentClient(http, 'owner', createCloudOfflineStore(database.db, 'owner'))
    await expect(client.startConnectionOAuth('connection')).rejects.toThrow('invalid authorization URL')
  })

  it('retries exactly the original message after a dropped response and a recreated client', async () => {
    const requests: string[] = []
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (request) => {
        requests.push(await (request as Request).text())
        if (requests.length === 1) {
          throw new TypeError('Network dropped after commit')
        }
        return Response.json({ id: 'same-run', commandId: submission.commandId })
      },
    })
    const store = createCloudOfflineStore(database.db, 'owner')
    await expect(createCloudAgentClient(http, 'owner', store).submitMessage('chat', submission)).rejects.toThrow(
      'Network dropped',
    )
    expect(await store.entries()).toHaveLength(1)
    await createCloudAgentClient(http, 'owner', createCloudOfflineStore(database.db, 'owner')).flushOutbox()
    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe(requests[0])
    expect(JSON.parse(requests[0])).toEqual(submission)
    expect(await store.entries()).toEqual([])
  })

  it('keeps an interrupted outbox command pending when its owner unmounts, then resumes it exactly', async () => {
    const store = createCloudOfflineStore(database.db, 'owner')
    await store.enqueue({
      id: submission.commandId,
      kind: 'message',
      resourceId: 'chat',
      endpoint: 'conversations/chat/messages',
      payload: JSON.stringify(submission),
    })
    const started = Promise.withResolvers<void>()
    const bodies: string[] = []
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (input) => {
        const request = input as Request
        bodies.push(await request.text())
        if (bodies.length > 1) {
          return Response.json({ id: 'run' })
        }
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
          started.resolve()
        })
      },
    })
    const controller = new AbortController()
    const syncing = createCloudAgentClient(http, 'owner', store).flushOutbox(controller.signal)
    await started.promise
    controller.abort()
    await syncing
    expect((await store.entries())[0].status).toBe('pending')
    await createCloudAgentClient(http, 'owner', store).flushOutbox()
    expect(bodies).toEqual([JSON.stringify(submission), JSON.stringify(submission)])
    expect(await store.entries()).toEqual([])
  })

  it('does not dispatch a later queued command discarded while an earlier request is in flight', async () => {
    const store = createCloudOfflineStore(database.db, 'owner')
    for (const id of ['first', 'second']) {
      await store.enqueue({
        id,
        kind: 'message',
        resourceId: 'chat',
        endpoint: 'conversations/chat/messages',
        payload: JSON.stringify({ ...submission, commandId: id }),
      })
    }
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    const bodies: string[] = []
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (request) => {
        bodies.push(await (request as Request).text())
        started.resolve()
        return response.promise
      },
    })
    const syncing = createCloudAgentClient(http, 'owner', store).flushOutbox()
    await started.promise
    await store.discard('second')
    response.resolve(Response.json({ id: 'run' }))
    await syncing
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]).commandId).toBe('first')
  })

  it('retains a permanent rejection for review instead of retrying forever', async () => {
    const requests: string[] = []
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (request) => {
        requests.push(await (request as Request).text())
        return Response.json({ error: 'revoked' }, { status: 403 })
      },
    })
    const store = createCloudOfflineStore(database.db, 'owner')
    const client = createCloudAgentClient(http, 'owner', store)
    await expect(client.submitMessage('chat', submission)).rejects.toThrow('403')
    await client.flushOutbox()
    expect(requests).toHaveLength(1)
    expect((await store.entries())[0]).toMatchObject({ status: 'needs-review', errorCode: '403' })
  })

  it('recognizes an already committed save after JSON object key order changes', async () => {
    const input = { id: 'agent', expectedVersion: 2, keyEpoch: 1, enabled: true, config: submission.content }
    const store = createCloudOfflineStore(database.db, 'owner')
    await store.enqueue({
      id: 'save',
      kind: 'agent-save',
      resourceId: 'agent',
      endpoint: 'agents/agent',
      payload: JSON.stringify(input),
    })
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (request) =>
        (request as Request).method === 'POST'
          ? Response.json({ error: 'conflict' }, { status: 409 })
          : Response.json({
              id: 'agent',
              version: 3,
              keyEpoch: 1,
              enabled: true,
              config: {
                ciphertext: submission.content.ciphertext,
                iv: submission.content.iv,
                kind: 'scoped-payload',
                version: 1,
              },
            }),
    })
    await createCloudAgentClient(http, 'owner', store).flushOutbox()
    expect(await store.entries()).toEqual([])
  })

  it('keeps a true save conflict unchanged and never rebases its expected version', async () => {
    const body = JSON.stringify({
      id: 'agent',
      expectedVersion: 2,
      keyEpoch: 1,
      enabled: true,
      config: submission.content,
    })
    const store = createCloudOfflineStore(database.db, 'owner')
    await store.enqueue({
      id: 'save',
      kind: 'agent-save',
      resourceId: 'agent',
      endpoint: 'agents/agent',
      payload: body,
    })
    const http = createClient({
      prefixUrl: 'https://cloud.test/v1',
      fetch: async (request) =>
        (request as Request).method === 'POST'
          ? Response.json({ error: 'conflict' }, { status: 409 })
          : Response.json({ id: 'agent', version: 4, keyEpoch: 1, enabled: true, config: submission.content }),
    })
    await createCloudAgentClient(http, 'owner', store).flushOutbox()
    expect((await store.entries())[0]).toMatchObject({ status: 'needs-review', errorCode: '409', payload: body })
  })
})
