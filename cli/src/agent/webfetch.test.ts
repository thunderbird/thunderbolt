/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { createWebFetchTool } from './webfetch.ts'
import type { WebFetchRequest } from './webfetch.ts'

/** Execute webfetch and return its text result. */
const execute = async (
  fetch: WebFetchRequest,
  url: string,
  options: { timeoutMs?: number; maxResponseBytes?: number; maxTextLength?: number } = {},
): Promise<string> => {
  const result = await createWebFetchTool({ fetch, ...options }).execute('webfetch-test', { url })
  const text = result.content.find((block) => block.type === 'text')
  if (!text || text.type !== 'text') throw new Error('webfetch returned no text')
  return text.text
}

describe('webfetch', () => {
  test('fetches a specific URL through injected fetch and follows redirects', async () => {
    const calls: Array<{ url: string; redirect: 'error' | 'follow' | 'manual' }> = []
    const fetch: WebFetchRequest = async (input, init) => {
      calls.push({ url: String(input), redirect: init?.redirect ?? 'manual' })
      return new Response('hello from web')
    }

    expect(await execute(fetch, 'https://example.com/article')).toContain('hello from web')
    expect(calls).toEqual([{ url: 'https://example.com/article', redirect: 'follow' }])
  })

  test('rejects schemes other than http and https before fetching', async () => {
    let calls = 0
    const fetch: WebFetchRequest = async () => {
      calls += 1
      return new Response('should not run')
    }

    await expect(execute(fetch, 'file:///etc/passwd')).rejects.toThrow(/only supports http.*https/i)
    expect(calls).toBe(0)
  })

  test('aborts a fetch after configured timeout', async () => {
    const fetch: WebFetchRequest = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })

    await expect(execute(fetch, 'https://example.com/slow', { timeoutMs: 5 })).rejects.toThrow(/timed out.*5ms/i)
  })

  test('caps response bytes before decoding', async () => {
    const fetch: WebFetchRequest = async () => new Response('abcdefghijklmnopqrstuvwxyz')

    const output = await execute(fetch, 'https://example.com/large', {
      maxResponseBytes: 8,
      maxTextLength: 100,
    })
    expect(output).toContain('abcdefgh')
    expect(output).not.toContain('ijklmnop')
    expect(output).toMatch(/truncated/i)
  })

  test('caps model-visible text after conversion', async () => {
    const fetch: WebFetchRequest = async () => new Response('abcdefghijklmnopqrstuvwxyz')

    const output = await execute(fetch, 'https://example.com/large', {
      maxResponseBytes: 100,
      maxTextLength: 8,
    })
    expect(output).toContain('abcdefgh')
    expect(output).not.toContain('ijklmnop')
    expect(output).toMatch(/truncated/i)
  })

  test('turns HTML into readable text without scripts, styles, tags, or encoded entities', async () => {
    const html = `<!doctype html><html><head><title>Example &amp; Test</title><style>.x { color: red }</style></head>
      <body><main><h1>Hello&nbsp;world</h1><p>First<br>Second</p><script>alert('no')</script></main></body></html>`
    const fetch: WebFetchRequest = async () =>
      new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })

    const output = await execute(fetch, 'https://example.com')
    expect(output).toContain('Example & Test')
    expect(output).toContain('Hello world')
    expect(output).toContain('First\nSecond')
    expect(output).not.toContain('<h1>')
    expect(output).not.toContain('color: red')
    expect(output).not.toContain("alert('no')")
  })
})
