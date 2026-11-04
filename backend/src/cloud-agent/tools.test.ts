/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import { Exa } from 'exa-js'
import { z } from 'zod'
import { createArtifactService } from './artifacts'
import { createServiceFixture } from './service-test-fixture'
import { createCloudTools } from './tools'

/** These registrations only use memo; durable memo/replay itself is covered by the runtime integration suite. */
const invocation = { memo: async <T>(_name: string, candidate: T): Promise<T> => candidate } as ToolExecutionApi

const execute = async (tools: ToolRegistration[], name: string, args: Record<string, unknown> = {}) => {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) {
    throw new Error('Tool ' + name + ' was not registered')
  }
  const result = await tool.execute(args, invocation, BACKGROUND_CONTEXT)
  const block = result.output?.[0]
  if (block?.type !== 'text') {
    throw new Error('Expected the registered tool to return JSON text')
  }
  return JSON.parse(block.text) as unknown
}

/** Keep the real Exa SDK's request construction, replacing only this instance's transport. */
const exaFixture = () => {
  const requests: { path: string; body: unknown }[] = []
  const client = new Exa('local-test-key')
  client.request = async <T>(path: string, _method: string, body?: unknown): Promise<T> => {
    requests.push({ path, body })
    const response: unknown = {
      requestId: 'test-request',
      results: [{ id: 'page', url: 'https://example.test/page', title: 'A page', text: 'Source text' }],
    }
    return response as T
  }
  return { requests, client }
}

const searchFixture = async () => {
  const f = await createServiceFixture()
  await f.service.saveAgent(f.ownerId, await f.agentInput({ searchEnabled: true }, 1))
  const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
  return { ...f, run, loaded: await f.service.loadRun(run.id) }
}

describe('cloud capability tool boundaries', () => {
  it('checks the current search grant before both Exa search and content dispatch', async () => {
    const f = await searchFixture()
    const exa = exaFixture()
    const registered = await createCloudTools(f.service, null, f.loaded, exa.client)
    try {
      await execute(registered.tools, 'web_search', { query: 'A question' })
      await execute(registered.tools, 'fetch_content', { url: 'https://example.test/page' })
      expect(exa.requests.map((request) => request.path.replace(/\/+/, '/'))).toEqual(['/search', '/contents'])
      await f.service.saveAgent(f.ownerId, await f.agentInput({ searchEnabled: false }, 2))
      // The saved run still grants search; the live account configuration must override it.
      expect((await f.service.loadRun(f.run.id)).config.searchEnabled).toBe(true)
      await expect(execute(registered.tools, 'web_search', { query: 'Do not send' })).rejects.toMatchObject({
        code: 'search_grant_revoked',
      })
      await expect(
        execute(registered.tools, 'fetch_content', { url: 'https://example.test/private' }),
      ).rejects.toMatchObject({ code: 'search_grant_revoked' })
      expect(exa.requests).toHaveLength(2)
    } finally {
      await registered.dispose()
    }
  })

  it('checks a stopped run before any search request reaches Exa', async () => {
    const f = await searchFixture()
    const exa = exaFixture()
    const registered = await createCloudTools(f.service, null, f.loaded, exa.client)
    try {
      await f.service.stop(f.ownerId, f.conversation.id)
      await expect(execute(registered.tools, 'web_search', { query: 'Do not send' })).rejects.toMatchObject({
        code: 'run_stopped',
      })
      await expect(
        execute(registered.tools, 'fetch_content', { url: 'https://example.test/page' }),
      ).rejects.toMatchObject({ code: 'run_stopped' })
      expect(exa.requests).toEqual([])
    } finally {
      await registered.dispose()
    }
  })

  it('continues without unavailable search and tells the model about missing local capabilities', async () => {
    const f = await searchFixture()
    const registered = await createCloudTools(
      f.service,
      null,
      {
        ...f.loaded,
        config: { ...f.loaded.config, mcpServers: [{ sourceId: 'local-files', name: 'Laptop files' }] },
      },
      null,
    )
    expect(registered.tools).toEqual([])
    expect(registered.instructions).toContain('Web search and page retrieval (Exa)')
    expect(registered.instructions).toContain('Laptop files')
    expect(registered.instructions).toContain('no cloud authorization')
    expect(registered.instructions).toContain('Continue using the capabilities available here')
    await registered.dispose()
  })

  it('returns compact artifact results and lists manifests without reading object bodies', async () => {
    const f = await createServiceFixture()
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    const objects = new Map<string, Uint8Array>()
    const reads: string[] = []
    const artifacts = createArtifactService({
      database: f.database,
      runtimeIdentity: f.runtimeIdentity,
      maxArtifactBytes: 1_000_000,
      maxStorageBytes: 10_000_000,
      objects: {
        put: async (key, bytes) => {
          objects.set(key, Uint8Array.from(bytes))
        },
        get: async (key) => {
          reads.push(key)
          const bytes = objects.get(key)
          if (!bytes) {
            throw new Error('Missing test object')
          }
          return Uint8Array.from(bytes)
        },
        remove: async (key) => {
          objects.delete(key)
        },
      },
    })
    const registered = await createCloudTools(f.service, artifacts, await f.service.loadRun(run.id), null)
    const change = z.strictObject({
      artifactId: z.string().uuid(),
      revisionId: z.string().uuid(),
      title: z.string(),
      conflict: z.boolean(),
    })
    const file = { path: 'memory.md', mediaType: 'text/markdown', content: 'Original memory' }
    try {
      const created = change.parse(
        await execute(registered.tools, 'create_artifact', {
          title: 'Memory',
          mediaType: 'text/markdown',
          files: [file],
        }),
      )
      expect(created.conflict).toBe(false)
      const updated = change.parse(
        await execute(registered.tools, 'update_artifact', {
          artifactId: created.artifactId,
          parentRevisionId: created.revisionId,
          title: 'Updated memory',
          mediaType: 'text/markdown',
          files: [{ ...file, content: 'Updated memory content' }],
        }),
      )
      expect(updated.artifactId).toBe(created.artifactId)
      expect(updated.revisionId).not.toBe(created.revisionId)
      expect(updated.conflict).toBe(false)
      const read = z
        .strictObject({
          artifactId: z.string(),
          revisionId: z.string(),
          title: z.string(),
          mediaType: z.string(),
          files: z.array(z.strictObject({ path: z.string(), mediaType: z.string(), content: z.string() })),
        })
        .parse(await execute(registered.tools, 'read_artifact', { artifactId: created.artifactId }))
      expect(read.files).toEqual([{ ...file, content: 'Updated memory content' }])
      expect(read.revisionId).toBe(updated.revisionId)
      const readsBeforeList = reads.length
      const listed = z
        .array(
          z.strictObject({
            id: z.string(),
            revisionId: z.string(),
            title: z.string(),
            mediaType: z.string(),
            writable: z.boolean(),
          }),
        )
        .parse(await execute(registered.tools, 'list_artifacts'))
      expect(listed).toEqual([
        {
          id: created.artifactId,
          revisionId: updated.revisionId,
          title: 'Updated memory',
          mediaType: 'text/markdown',
          writable: true,
        },
      ])
      expect(reads).toHaveLength(readsBeforeList)
    } finally {
      await registered.dispose()
    }
  })
})
