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
import { inferenceUsageReceiptHeader } from '../inference-usage.ts'
import {
  buildAppHarness,
  removeAgentWorkspace,
  workspaceDirFor,
  writeAgentWorkspaceFiles,
} from './build-app-harness.ts'
import { createReceiptLifecycle } from './confidential-model.ts'

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
  it('attaches the receipt lifecycle to the harness terminal message', async () => {
    const submitted: unknown[] = []
    const receipts = createReceiptLifecycle({
      submit: async (usage) => {
        submitted.push(usage)
      },
      reportError: () => {},
    })
    const fetch = async (): Promise<Response> =>
      new Response(
        [
          'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"glm-5-2","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
          'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"glm-5-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}',
          'data: [DONE]',
          '',
        ].join('\n\n'),
        {
          headers: {
            'content-type': 'text/event-stream',
            [inferenceUsageReceiptHeader]: 'signed-receipt',
          },
        },
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
        receipts,
        reasoning: true,
        contextWindow: 131_072,
        supportsImages: false,
      },
      systemPrompt: 'Answer briefly.',
      thinkingLevel: 'high',
      threadId: crypto.randomUUID(),
    })

    expect((await harness.prompt('hello')).stopReason).toBe('stop')
    expect(submitted).toEqual([{ receipt: 'signed-receipt', promptTokens: 4, completionTokens: 1, totalTokens: 5 }])
  })
})
