/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { HttpError, type HttpClient } from '@/lib/http'
import type { AgentCatalogResponse, DeployRequest, DeployResponse } from '@shared/agent-descriptors'
import { deployAgent, deploymentIdForAgent, fetchAgentCatalog, getDeploymentStatus } from './agent-deploy'

type Call = { url: string; options?: { json?: unknown } }

/** Build a fake HttpClient whose get/post resolve to `body`, recording calls. */
const makeClient = (body: unknown, opts: { throwStatus?: number } = {}) => {
  const calls: Call[] = []
  const respond = (url: string, options?: { json?: unknown }) => {
    calls.push({ url, options })
    return {
      json: async () => {
        if (opts.throwStatus) {
          throw new HttpError(new Response(null, { status: opts.throwStatus }))
        }
        return body
      },
    }
  }
  const client = {
    get: (url: string) => respond(url),
    post: (url: string, options?: { json?: unknown }) => respond(url, options),
  } as unknown as HttpClient
  return { client, calls }
}

const cloudUrl = 'https://api.test/v1'

const catalogBody: AgentCatalogResponse = {
  version: '1',
  descriptors: [
    {
      id: 'haystack',
      provider: 'haystack',
      name: 'Haystack',
      description: null,
      icon: null,
      schemaVersion: 1,
      action: 'deploy',
      steps: [{ id: 'basics', title: 'Basics', fields: [{ key: 'name', label: 'Name', widget: 'text' }] }],
    },
  ],
}

describe('fetchAgentCatalog', () => {
  it('returns the descriptors from the catalog envelope', async () => {
    const { client, calls } = makeClient(catalogBody)
    const descriptors = await fetchAgentCatalog(cloudUrl, client)
    expect(calls[0].url).toBe('https://api.test/v1/agents/catalog')
    expect(descriptors.map((d) => d.id)).toEqual(['haystack'])
  })

  it('returns [] when the feature is disabled (404)', async () => {
    const { client } = makeClient(null, { throwStatus: 404 })
    expect(await fetchAgentCatalog(cloudUrl, client)).toEqual([])
  })

  it('rethrows non-404 errors', async () => {
    const { client } = makeClient(null, { throwStatus: 500 })
    await expect(fetchAgentCatalog(cloudUrl, client)).rejects.toThrow()
  })
})

describe('deployAgent', () => {
  it('POSTs the request and parses the response', async () => {
    const body: DeployResponse = {
      deploymentId: 'haystack:tb-x',
      status: 'pending',
      connection: { url: 'wss://h/v1/haystack/ws?pipeline=tb-x', transport: 'websocket' },
    }
    const { client, calls } = makeClient(body)
    const request: DeployRequest = { descriptorId: 'haystack', schemaVersion: 1, spec: { name: 'Bot' } }
    const result = await deployAgent(cloudUrl, client, request)
    expect(calls[0].url).toBe('https://api.test/v1/agents/deploy')
    expect(calls[0].options?.json).toEqual(request)
    expect(result).toEqual(body)
  })
})

describe('deploymentIdForAgent', () => {
  it('derives <provider>:<ref> from a managed agent url', () => {
    expect(deploymentIdForAgent({ type: 'managed-acp', url: 'wss://h/v1/haystack/ws?pipeline=tb-x' })).toBe(
      'haystack:tb-x',
    )
  })

  it('returns null for non-managed agents', () => {
    expect(deploymentIdForAgent({ type: 'remote-acp', url: 'wss://h/v1/haystack/ws?pipeline=tb-x' })).toBeNull()
  })

  it('returns null when the url carries no pipeline ref', () => {
    expect(deploymentIdForAgent({ type: 'managed-acp', url: 'wss://h/v1/haystack/ws' })).toBeNull()
  })

  it('returns null for a missing or malformed url', () => {
    expect(deploymentIdForAgent({ type: 'managed-acp', url: null })).toBeNull()
    expect(deploymentIdForAgent({ type: 'managed-acp', url: 'not a url' })).toBeNull()
  })
})

describe('getDeploymentStatus', () => {
  it('encodes the deployment id and parses the status', async () => {
    const { client, calls } = makeClient({ deploymentId: 'haystack:tb-x', status: 'running', connection: null })
    const result = await getDeploymentStatus(cloudUrl, client, 'haystack:tb-x')
    expect(calls[0].url).toBe('https://api.test/v1/agents/deployments/haystack%3Atb-x')
    expect(result.status).toBe('running')
  })
})
