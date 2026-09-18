/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, webkit } from 'playwright'

const temporaryDist = await mkdtemp(join(tmpdir(), 'thunderbolt-agent-core-'))
const dist = resolve(process.env.BROWSER_TEST_DIST ?? temporaryDist)
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => {
    const pathname = new URL(request.url).pathname
    if (pathname === '/')
      return new Response('<!doctype html><title>Agent core regression</title><div id="root"></div>', {
        headers: { 'Content-Type': 'text/html' },
      })
    const file = resolve(dist, `.${pathname}`)
    if (!file.startsWith(`${dist}/`)) return new Response(null, { status: 403 })
    return new Response(Bun.file(file))
  },
})
try {
  if (!process.env.BROWSER_TEST_DIST) {
    const build = Bun.spawn(['bun', 'run', 'build', '--', '--outDir', dist], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    assert.equal(await build.exited, 0)
  }
  const chunks = (await readdir(join(dist, 'assets'))).filter((name) => /^agent-core-.*\.js$/.test(name))
  assert.equal(chunks.length, 1)
  const chunkUrl = `/assets/${chunks[0]}`
  const failures: unknown[] = []

  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    for (const removeIteratorHelpers of [false, true]) {
      const label = `${engineName}: production harness, conversation and OPFS (iterator helpers ${removeIteratorHelpers ? 'absent' : 'native'})`
      // WebKit's ephemeral contexts reject OPFS; each case needs its own persistent profile.
      const browser = await engine.launchPersistentContext(
        join(temporaryDist, `${engineName}-${removeIteratorHelpers}`),
      )
      const timeout = setTimeout(() => {
        void browser.close()
      }, 60_000)
      try {
        // Shared app chunks can initialize config/auth; keep all network access local to this fixture.
        await browser.route(
          (url) => url.origin !== server.url.origin,
          (route) => route.fulfill({ json: {} }),
        )
        const page = await browser.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        if (removeIteratorHelpers) {
          await page.addInitScript(() => {
            const iterator = [][Symbol.iterator]()
            const prototype = Object.getPrototypeOf(Object.getPrototypeOf(iterator))
            for (const helper of [
              'map',
              'filter',
              'take',
              'drop',
              'flatMap',
              'reduce',
              'toArray',
              'forEach',
              'some',
              'every',
              'find',
            ]) {
              Reflect.deleteProperty(prototype, helper)
              if (Reflect.has(iterator, helper)) throw new Error(`Iterator helper ${helper} still exists`)
            }
          })
        }
        /** Let the shared app entry finish its OPFS create/delete probe before ZenFS scans the root. */
        const loadHarness = async () => {
          await Promise.all([
            page.waitForEvent('console', (message) => message.text().startsWith('[init] step2_initialize_database:')),
            page.evaluate(async (url) => {
              await import(url)
            }, chunkUrl),
          ])
        }
        await page.goto(server.url.href)
        await loadHarness()
        const results = await page.evaluate(async (url) => {
          // Import the emitted app chunk, after removing helpers: a source/Bun import misses this regression.
          const core: typeof import('../shared/agent-core/index.ts') = await import(url)
          const backend = await core.mountAgentFs()
          const conversations = []
          for (const providerId of ['openrouter', 'thunderbolt', 'tinfoil']) {
            const requests: string[] = []
            const model = {
              providerId,
              modelId: providerId === 'tinfoil' ? 'glm-5-2' : 'test',
              baseURL: 'https://provider.invalid/v1',
              apiKey: 'test-placeholder',
              reasoning: false,
              supportsImages: false,
              fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
                requests.push(String(init?.body))
                return new Response(
                  [
                    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"hello back"},"finish_reason":null}]}',
                    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
                    'data: [DONE]',
                    '',
                  ].join('\n\n'),
                  { headers: { 'Content-Type': 'text/event-stream' } },
                )
              },
            }
            const harness = await core.buildAppHarness({
              model:
                providerId === 'tinfoil'
                  ? {
                      ...model,
                      kind: 'confidential',
                      vendor: 'zhipu',
                      receipts: core.createReceiptLifecycle({
                        submit: async () => {},
                        reportError: (error) => {
                          throw error
                        },
                      }),
                    }
                  : { ...model, kind: 'openai-compat' },
              systemPrompt: 'Answer briefly.',
              thinkingLevel: 'off',
              threadId: providerId,
            })
            const first = await harness.prompt('hello first turn')
            const second = await harness.prompt('hello second turn')
            conversations.push({ providerId, first, second, requests })
          }
          const env = new core.BrowserExecutionEnv({ cwd: core.workspaceDirFor('openrouter') })
          const written = await env.writeFile('persist.txt', 'survives reload')
          if (!written.ok) throw written.error
          return { backend, conversations }
        }, chunkUrl)
        assert.equal(results.backend, 'opfs')
        for (const { first, second, requests } of results.conversations) {
          for (const response of [first, second]) {
            assert.equal(response.stopReason, 'stop')
            assert.deepEqual(response.content, [{ type: 'text', text: 'hello back' }])
          }
          assert.equal(requests.length, 2)
          assert.ok(requests[1].includes('hello first turn'))
          assert.ok(requests[1].includes('hello back'))
        }
        await page.reload()
        await loadHarness()
        const persisted = await page.evaluate(async (url) => {
          const core: typeof import('../shared/agent-core/index.ts') = await import(url)
          const backend = await core.mountAgentFs()
          const env = new core.BrowserExecutionEnv({ cwd: core.workspaceDirFor('openrouter') })
          const read = await env.readTextFile('persist.txt')
          if (!read.ok) throw read.error
          return { backend, text: read.value }
        }, chunkUrl)
        assert.deepEqual(persisted, { backend: 'opfs', text: 'survives reload' })
        assert.deepEqual(errors, [])
        console.log(`PASS ${label}`)
      } catch (error) {
        console.error(`FAIL ${label}`, error)
        failures.push(error)
      } finally {
        clearTimeout(timeout)
        await browser.close()
      }
    }
  }
  assert.equal(failures.length, 0, `${failures.length} browser checks failed`)
} finally {
  await server.stop(true)
  await rm(temporaryDist, { recursive: true, force: true })
}
