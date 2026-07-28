/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { DeepsetManagementClient, DeepsetManagementError, type HaystackManagementConfig } from './management-client'

const config: HaystackManagementConfig = {
  haystackBaseUrl: 'https://api.cloud.deepset.ai',
  haystackApiKey: 'sk-test',
  haystackWorkspace: 'tutorial',
}

type FakeResult = { status?: number; body?: unknown; text?: string }
type Call = { url: string; init?: RequestInit }

const makeFetch = (handler: (url: string, init?: RequestInit) => FakeResult) => {
  const calls: Call[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const result = handler(url, init)
    const status = result.status ?? 200
    const bodyText = result.text ?? (result.body !== undefined ? JSON.stringify(result.body) : '')
    return new Response(bodyText, { status, statusText: status >= 400 ? 'Error' : 'OK' })
  }) as typeof fetch
  return { fetchFn, calls }
}

const wsBase = 'https://api.cloud.deepset.ai/api/v1/workspaces/tutorial'

const pipeline = {
  name: 'tb-my-agent',
  pipeline_id: '70d781d8-4d4c-4154-95c1-6422cdf2c6fb',
  status: 'DEPLOYMENT_IN_PROGRESS',
  desired_status: 'DEPLOYED',
}

describe('DeepsetManagementClient', () => {
  it('creates a pipeline with the v2 body and drains the 201', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 201, body: { name: 'tb-my-agent' } }))
    const client = new DeepsetManagementClient(config, { fetchFn })
    await client.createPipeline({ name: 'tb-my-agent', queryYaml: 'components: {}' })
    expect(calls[0].url).toBe(`${wsBase}/pipelines`)
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      name: 'tb-my-agent',
      query_yaml: 'components: {}',
      deepset_cloud_version: 'v2',
    })
  })

  it('appends dry_run when requested', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 201, body: { name: 'x' } }))
    const client = new DeepsetManagementClient(config, { fetchFn })
    await client.createPipeline({ name: 'x', queryYaml: 'y', dryRun: true })
    expect(calls[0].url).toBe(`${wsBase}/pipelines?dry_run=true`)
  })

  it('sends the bearer token from config', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 201, body: { name: 'x' } }))
    await new DeepsetManagementClient(config, { fetchFn }).createPipeline({ name: 'x', queryYaml: 'y' })
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })

  it('omits the auth header when no api key is configured', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 201, body: { name: 'x' } }))
    await new DeepsetManagementClient({ ...config, haystackApiKey: '' }, { fetchFn }).createPipeline({
      name: 'x',
      queryYaml: 'y',
    })
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('deploys and returns the parsed pipeline', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 200, body: pipeline }))
    const client = new DeepsetManagementClient(config, { fetchFn })
    const result = await client.deployPipeline('tb-my-agent')
    expect(calls[0].url).toBe(`${wsBase}/pipelines/tb-my-agent/deploy`)
    expect(result.status).toBe('DEPLOYMENT_IN_PROGRESS')
    expect(result.pipeline_id).toBe(pipeline.pipeline_id)
  })

  it('gets pipeline status', async () => {
    const { fetchFn } = makeFetch(() => ({ status: 200, body: { ...pipeline, status: 'DEPLOYED' } }))
    const result = await new DeepsetManagementClient(config, { fetchFn }).getPipeline('tb-my-agent')
    expect(result.status).toBe('DEPLOYED')
  })

  it('lists pipelines from the data envelope', async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      status: 200,
      body: { data: [pipeline, { ...pipeline, name: 'b' }] },
    }))
    const result = await new DeepsetManagementClient(config, { fetchFn }).listPipelines()
    expect(calls[0].url).toBe(`${wsBase}/pipelines?limit=100`)
    expect(result.map((p) => p.name)).toEqual(['tb-my-agent', 'b'])
  })

  it('fetches the pipeline query_yaml', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 200, body: { query_yaml: 'components:\n  agent: {}' } }))
    const yaml = await new DeepsetManagementClient(config, { fetchFn }).getPipelineYaml('Rai-RAG-Research-Agent')
    expect(calls[0].url).toBe(`${wsBase}/pipelines/Rai-RAG-Research-Agent/yaml`)
    expect(yaml).toContain('components:')
  })

  it('undeploys and deletes with the right methods', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 200, text: '' }))
    const client = new DeepsetManagementClient(config, { fetchFn })
    await client.undeployPipeline('tb-my-agent')
    await client.deletePipeline('tb-my-agent')
    expect(calls[0].url).toBe(`${wsBase}/pipelines/tb-my-agent/undeploy`)
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[1].url).toBe(`${wsBase}/pipelines/tb-my-agent`)
    expect(calls[1].init?.method).toBe('DELETE')
  })

  it('throws DeepsetManagementError on a non-2xx response', async () => {
    const { fetchFn } = makeFetch(() => ({ status: 422, text: 'invalid yaml' }))
    const client = new DeepsetManagementClient(config, { fetchFn })
    const error = await client.deployPipeline('bad').catch((e) => e)
    expect(error).toBeInstanceOf(DeepsetManagementError)
    expect(error.status).toBe(422)
    expect(error.message).toContain('invalid yaml')
  })
})
