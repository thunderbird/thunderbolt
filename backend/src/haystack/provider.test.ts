/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createTestSettings } from '@/test-utils/settings'
import type { ProviderContext } from '@/agents'
import { createHaystackProvider } from './provider'

const deployableSettings = () =>
  createTestSettings({
    haystackBaseUrl: 'https://api.cloud.deepset.ai',
    haystackApiKey: 'sk-test',
    haystackWorkspace: 'tutorial',
    haystackTemplatePipeline: 'Template-Pipeline',
  })

const makeContext = (settings = deployableSettings()): ProviderContext => ({
  request: new Request('http://localhost:8000/v1/agents/deploy'),
  settings,
  userId: 'user-1',
})

type Route = (url: string, init?: RequestInit) => { status?: number; body?: unknown } | undefined

const routedFetch = (routes: Route) => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const result = routes(url, init) ?? { status: 404, body: { error: 'no route' } }
    const status = result.status ?? 200
    return new Response(result.body !== undefined ? JSON.stringify(result.body) : '', {
      status,
      statusText: status >= 400 ? 'Error' : 'OK',
    })
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('haystack provider — catalog', () => {
  it('offers the descriptor when deploy is configured', () => {
    const provider = createHaystackProvider()
    const catalog = provider.catalog!(makeContext())
    expect(catalog).toHaveLength(1)
    expect(catalog[0].id).toBe('haystack')
    expect(catalog[0].provider).toBe('haystack')
  })

  it('offers nothing when the template pipeline is unset', () => {
    const provider = createHaystackProvider()
    const catalog = provider.catalog!(makeContext(createTestSettings({ haystackTemplatePipeline: '' })))
    expect(catalog).toEqual([])
  })
})

describe('haystack provider — deploy', () => {
  it('clones the template yaml, creates under tb- namespace, and deploys', async () => {
    const { fetchFn, calls } = routedFetch((url, init) => {
      if (url.endsWith('/pipelines/Template-Pipeline/yaml')) {
        return { status: 200, body: { query_yaml: 'components:\n  agent: {}' } }
      }
      if (init?.method === 'POST' && url.endsWith('/pipelines')) {
        return { status: 201, body: { name: 'created' } }
      }
      if (init?.method === 'POST' && url.endsWith('/deploy')) {
        return { status: 200, body: { name: 'ref', pipeline_id: 'pid-1', status: 'DEPLOYMENT_IN_PROGRESS' } }
      }
      return undefined
    })
    const provider = createHaystackProvider({ fetchFn })
    const result = await provider.deploy!({ name: 'My Agent' }, makeContext())

    expect(result.deploymentId.startsWith('haystack:tb-my-agent-')).toBe(true)
    expect(result.status).toBe('pending')
    // The create body carried the cloned template YAML.
    const createCall = calls.find((c) => c.init?.method === 'POST' && c.url.endsWith('/pipelines'))
    expect(JSON.parse(String(createCall?.init?.body)).query_yaml).toContain('agent: {}')
  })
})

describe('haystack provider — status', () => {
  const statusProvider = (deepsetStatus: string) => {
    const { fetchFn } = routedFetch(() => ({
      status: 200,
      body: { name: 'tb-x', pipeline_id: 'pid-1', status: deepsetStatus },
    }))
    return createHaystackProvider({ fetchFn })
  }

  it('maps DEPLOYED to running with a websocket connection', async () => {
    const result = await statusProvider('DEPLOYED').status!('tb-my-agent-abc', makeContext())
    expect(result.status).toBe('running')
    expect(result.connection?.transport).toBe('websocket')
    expect(result.connection?.url).toContain('haystack/ws?pipeline=tb-my-agent-abc')
    expect(result.deploymentId).toBe('haystack:tb-my-agent-abc')
  })

  it('maps an in-progress status to pending with no connection', async () => {
    const result = await statusProvider('DEPLOYMENT_IN_PROGRESS').status!('tb-x', makeContext())
    expect(result.status).toBe('pending')
    expect(result.connection).toBeNull()
  })

  it('maps a failure status to failed', async () => {
    const result = await statusProvider('DEPLOYMENT_FAILED').status!('tb-x', makeContext())
    expect(result.status).toBe('failed')
  })
})
