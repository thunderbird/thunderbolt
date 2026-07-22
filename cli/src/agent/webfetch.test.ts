/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { createWebFetchTool, htmlToText } from './webfetch.ts'
import type { WebFetchDependencies, WebFetchRequest } from './webfetch.ts'

/** Resolve test hostnames to a stable public address without real DNS. */
const publicResolver = async (): Promise<ReadonlyArray<{ address: string }>> => [{ address: '93.184.216.34' }]

/** Execute webfetch and return its text result. */
const execute = async (
  fetch: WebFetchRequest,
  url: string,
  options: Omit<WebFetchDependencies, 'fetch'> = {},
): Promise<string> => {
  const result = await createWebFetchTool({ fetch, resolve: publicResolver, ...options }).execute('webfetch-test', {
    url,
  })
  const text = result.content.find((block) => block.type === 'text')
  if (!text || text.type !== 'text') throw new Error('webfetch returned no text')
  return text.text
}

describe('webfetch', () => {
  test('rejects private IPv4 literals without DNS or fetch', async () => {
    let resolverCalls = 0
    let fetchCalls = 0
    const fetch: WebFetchRequest = async () => {
      fetchCalls += 1
      return new Response('should not run')
    }

    await expect(
      execute(fetch, 'http://10.0.0.1/secrets', {
        resolve: async () => {
          resolverCalls += 1
          return publicResolver()
        },
      }),
    ).rejects.toThrow('refusing to fetch private or internal address')
    expect(resolverCalls).toBe(0)
    expect(fetchCalls).toBe(0)
  })

  test('rejects IPv4 loopback literals', async () => {
    const fetch: WebFetchRequest = async () => new Response('should not run')

    await expect(execute(fetch, 'http://127.0.0.1/admin')).rejects.toThrow(
      'refusing to fetch private or internal address',
    )
  })

  test('rejects the AWS metadata link-local address', async () => {
    const fetch: WebFetchRequest = async () => new Response('should not run')

    await expect(execute(fetch, 'http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'refusing to fetch private or internal address',
    )
  })

  test('rejects IPv6 link-local and unique-local literals', async () => {
    const fetch: WebFetchRequest = async () => new Response('should not run')

    await expect(execute(fetch, 'http://[fe80::1]/')).rejects.toThrow('refusing to fetch private or internal address')
    await expect(execute(fetch, 'http://[fc00::1]/')).rejects.toThrow('refusing to fetch private or internal address')
  })

  test('rejects reserved IPv6 documentation literals', async () => {
    const fetch: WebFetchRequest = async () => new Response('should not run')

    await expect(execute(fetch, 'http://[3fff::1]/')).rejects.toThrow('refusing to fetch private or internal address')
  })

  test('allows a public hostname when every resolved address is public', async () => {
    const fetch: WebFetchRequest = async () => new Response('public response')

    await expect(
      execute(fetch, 'https://public.example', {
        resolve: async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1:248:1893:25c8:1946' }],
      }),
    ).resolves.toBe('public response')
  })

  test('pins a hostname to the first resolved address and sends the original Host header', async () => {
    const calls: Array<{ readonly url: string; readonly host: string | null }> = []
    const fetch: WebFetchRequest = async (input, init) => {
      calls.push({ url: String(input), host: new Headers(init?.headers).get('host') })
      return new Response('public response')
    }

    await execute(fetch, 'https://public.example/article?q=1', {
      resolve: async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1:248:1893:25c8:1946' }],
    })

    expect(calls).toEqual([{ url: 'https://93.184.216.34/article?q=1', host: 'public.example' }])
  })

  test('uses one DNS answer for validation and connection', async () => {
    const resolverCalls: string[] = []
    const calls: string[] = []
    const fetch: WebFetchRequest = async (input) => {
      calls.push(String(input))
      return new Response('public response')
    }

    await execute(fetch, 'https://rebind.example/secrets', {
      resolve: async (hostname) => {
        resolverCalls.push(hostname)
        return resolverCalls.length === 1 ? [{ address: '93.184.216.34' }] : [{ address: '169.254.169.254' }]
      },
    })

    expect(resolverCalls).toEqual(['rebind.example'])
    expect(calls).toEqual(['https://93.184.216.34/secrets'])
  })

  test('re-pins every redirect hop with one resolution per hostname', async () => {
    const resolverCalls: string[] = []
    const calls: Array<{ readonly url: string; readonly host: string | null }> = []
    const fetch: WebFetchRequest = async (input, init) => {
      calls.push({ url: String(input), host: new Headers(init?.headers).get('host') })
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://redirect.example/final' } })
        : new Response('redirected response')
    }

    await execute(fetch, 'https://origin.example/start', {
      resolve: async (hostname) => {
        resolverCalls.push(hostname)
        return [{ address: hostname === 'origin.example' ? '93.184.216.34' : '8.8.8.8' }]
      },
    })

    expect(resolverCalls).toEqual(['origin.example', 'redirect.example'])
    expect(calls).toEqual([
      { url: 'https://93.184.216.34/start', host: 'origin.example' },
      { url: 'https://8.8.8.8/final', host: 'redirect.example' },
    ])
  })

  test('brackets a resolved IPv6 address in the pinned URL', async () => {
    const calls: Array<{ readonly url: string; readonly host: string | null }> = []
    const fetch: WebFetchRequest = async (input, init) => {
      calls.push({ url: String(input), host: new Headers(init?.headers).get('host') })
      return new Response('IPv6 response')
    }

    await execute(fetch, 'https://ipv6.example/article', {
      resolve: async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946' }],
    })

    expect(calls).toEqual([
      { url: 'https://[2606:2800:220:1:248:1893:25c8:1946]/article', host: 'ipv6.example' },
    ])
  })

  test('rejects a hostname when any resolved address is private', async () => {
    const fetch: WebFetchRequest = async () => new Response('should not run')

    await expect(
      execute(fetch, 'https://mixed.example', {
        resolve: async () => [{ address: '93.184.216.34' }, { address: '192.168.1.10' }],
      }),
    ).rejects.toThrow('refusing to fetch private or internal address')
  })

  test('rejects a redirect from a public host to a private target', async () => {
    const calls: string[] = []
    const fetch: WebFetchRequest = async (input) => {
      calls.push(String(input))
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/secrets' } })
    }

    await expect(execute(fetch, 'https://public.example/start')).rejects.toThrow(
      'refusing to fetch private or internal address',
    )
    expect(calls).toEqual(['https://93.184.216.34/start'])
  })

  test('enforces the five-hop redirect cap', async () => {
    const calls: string[] = []
    const fetch: WebFetchRequest = async (input) => {
      calls.push(String(input))
      return new Response(null, {
        status: 302,
        headers: { location: `https://public-${calls.length}.example/next` },
      })
    }

    await expect(execute(fetch, 'https://public-0.example/start')).rejects.toThrow(/redirect limit.*5/i)
    expect(calls).toHaveLength(6)
  })

  test('fetches a specific URL through injected fetch', async () => {
    const calls: Array<{ url: string; redirect: 'error' | 'follow' | 'manual' }> = []
    const fetch: WebFetchRequest = async (input, init) => {
      calls.push({ url: String(input), redirect: init?.redirect ?? 'manual' })
      return new Response('hello from web')
    }

    expect(await execute(fetch, 'https://example.com/article')).toContain('hello from web')
    expect(calls).toEqual([{ url: 'https://93.184.216.34/article', redirect: 'manual' }])
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

  test('removes hidden content exposed by nested tags and comments', async () => {
    const html = `<scr<script></script>ipt>nested script</script>
      <!<!---->-->nested comment--><p>Visible content</p>`
    const fetch: WebFetchRequest = async () => new Response(html, { headers: { 'content-type': 'text/html' } })

    const output = await execute(fetch, 'https://example.com')

    expect(output).toBe('Visible content')
  })

  test('escapes angle brackets that survive the bounded strip passes', async () => {
    const pathological = '<'.repeat(40) + 'script>alert(1)</script' + '>'.repeat(40)
    const fetch: WebFetchRequest = async () =>
      new Response(pathological, { headers: { 'content-type': 'text/html' } })

    const output = await execute(fetch, 'https://example.com')

    expect(output).not.toContain('<')
  })
})

describe('htmlToText', () => {
  test('drops an unterminated comment', () => {
    expect(htmlToText('Before<!-- hidden')).toBe('Before')
  })

  test('drops an unterminated raw-text element', () => {
    expect(htmlToText('Before<script>hidden')).toBe('Before')
  })

  test('matches raw-text closing tags case-insensitively with trailing whitespace', () => {
    expect(htmlToText('Before<ScRiPt>hidden</sCrIpT \n>After')).toBe('BeforeAfter')
  })

  test('escapes an opening angle bracket at end of input', () => {
    expect(htmlToText('Before<')).toBe('Before&lt;')
  })
})
