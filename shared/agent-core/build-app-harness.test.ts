/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for {@link workspaceDirFor} — the per-thread workspace path that is
 * ALSO the coding-tool jail boundary. A threadId carrying `/` or `..` would move
 * that boundary and defeat per-thread isolation, so the function must reject any
 * non-UUID-shaped id loudly.
 */

import { describe, expect, it } from 'bun:test'
import * as fsp from '@zenfs/core/promises'
import {
  buildAppHarness,
  removeAgentWorkspace,
  workspaceDirFor,
  writeAgentWorkspaceFiles,
} from './build-app-harness.ts'
import type { WorkspaceSnapshot } from './workspace-store.ts'

describe('workspaceDirFor', () => {
  it('roots a UUID-shaped thread under /workspace', () => {
    expect(workspaceDirFor('3cc2bf39-afa2-44d1-a89b-a1ecec7bb067')).toBe(
      '/workspace/3cc2bf39-afa2-44d1-a89b-a1ecec7bb067',
    )
  })

  it('allows the dot/underscore/hyphen characters that may appear in ids', () => {
    expect(workspaceDirFor('a.b_c-D9')).toBe('/workspace/a.b_c-D9')
  })

  it.each([
    ['contains a slash', 'a/b'],
    ['is a parent-traversal segment', '..'],
    ['is the current-dir segment', '.'],
    ['embeds a traversal path', '../../etc'],
    ['contains a backslash-style separator attempt', 'a\\b'],
    ['contains whitespace', 'a b'],
    ['is empty', ''],
  ])('throws when the threadId %s', (_why, threadId) => {
    expect(() => workspaceDirFor(threadId)).toThrow(/unsafe threadId/)
  })
})

describe('writeAgentWorkspaceFiles', () => {
  const readWorkspaceFile = (threadId: string, path: string) =>
    fsp.readFile(`${workspaceDirFor(threadId)}/${path}`, 'utf-8')

  it('writes files at workspace-relative paths, creating directories', async () => {
    const threadId = crypto.randomUUID()
    await writeAgentWorkspaceFiles(threadId, [{ path: 'attachments/a/data.tsv', content: 'x\ty\n1\t2' }])
    expect(await readWorkspaceFile(threadId, 'attachments/a/data.tsv')).toBe('x\ty\n1\t2')
    await removeAgentWorkspace(threadId)
  })

  it('overwrites a same-size edit with the original content', async () => {
    const threadId = crypto.randomUUID()
    await writeAgentWorkspaceFiles(threadId, [{ path: 'a.txt', content: '100' }])
    await fsp.writeFile(`${workspaceDirFor(threadId)}/a.txt`, '900')
    await writeAgentWorkspaceFiles(threadId, [{ path: 'a.txt', content: '100' }])
    expect(await readWorkspaceFile(threadId, 'a.txt')).toBe('100')
    await removeAgentWorkspace(threadId)
  })

  it('reports a path that escapes the workspace instead of writing it', async () => {
    const threadId = crypto.randomUUID()
    const failures = await writeAgentWorkspaceFiles(threadId, [{ path: '../escape.txt', content: 'x' }])
    expect(failures.map(({ path, error }) => ({ path, code: error.code }))).toEqual([
      { path: '../escape.txt', code: 'permission_denied' },
    ])
    await removeAgentWorkspace(threadId)
  })

  it('writes the remaining files after one fails, returning only the failure', async () => {
    const threadId = crypto.randomUUID()
    // 'blocked' is a file, so writing under it fails.
    await writeAgentWorkspaceFiles(threadId, [{ path: 'blocked', content: 'file' }])
    const failures = await writeAgentWorkspaceFiles(threadId, [
      { path: 'blocked/inner.txt', content: 'x' },
      { path: 'ok.txt', content: 'fine' },
    ])
    expect(failures.map(({ path }) => path)).toEqual(['blocked/inner.txt'])
    expect(await readWorkspaceFile(threadId, 'ok.txt')).toBe('fine')
    await removeAgentWorkspace(threadId)
  })
})

describe('buildAppHarness confidential model', () => {
  it('runs a confidential model turn to its terminal message', async () => {
    const fetch = async (): Promise<Response> =>
      new Response(
        [
          'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"glm-5-2","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
          'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"glm-5-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}',
          'data: [DONE]',
          '',
        ].join('\n\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    const harness = await buildAppHarness({
      model: {
        kind: 'confidential',
        providerId: 'thunderbolt',
        modelId: 'glm-5-2',
        vendor: 'zhipu',
        baseURL: 'https://cloud.example/v1/tinfoil',
        apiKey: 'placeholder',
        fetch,
        reasoning: true,
        contextWindow: 131_072,
        supportsImages: false,
      },
      systemPrompt: 'Answer briefly.',
      thinkingLevel: 'high',
      threadId: crypto.randomUUID(),
    })

    expect((await harness.prompt('hello')).stopReason).toBe('stop')
  })
})

describe('buildAppHarness workspace store', () => {
  it('restores a thread snapshot and saves it through the returned persistence boundary', async () => {
    const threadId = crypto.randomUUID()
    const saved: WorkspaceSnapshot[] = []
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      entries: [
        { path: 'nested', kind: 'directory' },
        { path: 'nested/seed.txt', kind: 'file', base64: Buffer.from('seed').toString('base64'), byteCount: 4 },
      ],
    }
    const harness = await buildAppHarness({
      model: {
        kind: 'confidential',
        providerId: 'thunderbolt',
        modelId: 'glm-5-2',
        vendor: 'zhipu',
        baseURL: 'https://cloud.example/v1/tinfoil',
        apiKey: 'placeholder',
        fetch: async () => new Response('', { status: 500 }),
        reasoning: true,
        contextWindow: 131_072,
        supportsImages: false,
      },
      systemPrompt: 'Answer briefly.',
      thinkingLevel: 'high',
      threadId,
      workspaceStore: {
        load: async (loadedThreadId) => (loadedThreadId === threadId ? snapshot : undefined),
        save: async (savedThreadId, value) => {
          expect(savedThreadId).toBe(threadId)
          saved.push(value)
        },
      },
    })

    expect(await fsp.readFile(`${workspaceDirFor(threadId)}/nested/seed.txt`, 'utf-8')).toBe('seed')
    await harness.persistWorkspace()
    expect(saved).toHaveLength(1)
    expect(saved[0]?.entries).toContainEqual({
      path: 'nested/seed.txt',
      kind: 'file',
      base64: Buffer.from('seed').toString('base64'),
      byteCount: 4,
    })
    await removeAgentWorkspace(threadId)
  })
})

describe('buildAppHarness coding tools', () => {
  it('can disable the jailed coding tools while keeping the canonical harness', async () => {
    const threadId = crypto.randomUUID()
    const harness = await buildAppHarness({
      model: {
        kind: 'confidential',
        providerId: 'thunderbolt',
        modelId: 'glm-5-2',
        vendor: 'zhipu',
        baseURL: 'https://cloud.example/v1/tinfoil',
        apiKey: 'placeholder',
        fetch: async () => new Response('', { status: 500 }),
        reasoning: true,
        contextWindow: 131_072,
        supportsImages: false,
      },
      systemPrompt: 'Answer briefly.',
      thinkingLevel: 'high',
      threadId,
      codingToolsEnabled: false,
    })

    expect(harness.getTools()).toEqual([])
    await removeAgentWorkspace(threadId)
  })
})
