/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Deepset Cloud pipeline management (create / deploy / status / list), the
 * lifecycle counterpart to the runtime `HaystackAcpServer`. Deepset ships no
 * JS SDK and no public OpenAPI, so this is raw `fetch` + zod against the
 * spike-confirmed REST shapes (THU-743):
 *
 *   create  POST   /pipelines            {name, query_yaml, deepset_cloud_version:'v2'}  → 201 {name}
 *   deploy  POST   /pipelines/:name/deploy                                               → 200 pipeline
 *   status  GET    /pipelines/:name                                                      → 200 pipeline
 *   list    GET    /pipelines?limit=N                                                    → 200 {data:[…]}
 *   yaml    GET    /pipelines/:name/yaml                                                 → 200 {query_yaml}
 *
 * Statuses seen: `DEPLOYMENT_IN_PROGRESS` (transient), `DEPLOYED` (running),
 * `FAILED`/`DEPLOYMENT_FAILED`. All URLs are workspace-scoped.
 */

import type { Settings } from '@/config/settings'
import { z } from 'zod'

/** The Deepset config this client needs — a subset of {@link Settings}. */
export type HaystackManagementConfig = Pick<Settings, 'haystackBaseUrl' | 'haystackApiKey' | 'haystackWorkspace'>

export type HaystackManagementDeps = {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch
}

/** A non-2xx response from Deepset, carrying the status and body for diagnosis. */
export class DeepsetManagementError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`deepset management ${status} ${statusText}: ${body}`)
    this.name = 'DeepsetManagementError'
  }
}

/** A Deepset pipeline as returned by deploy / status / list. Extra fields are
 *  tolerated (stripped) so Deepset can evolve its payload without breaking us. */
export const deepsetPipelineSchema = z.object({
  name: z.string(),
  pipeline_id: z.string(),
  status: z.string(),
  desired_status: z.string().nullable().optional(),
})
export type DeepsetPipeline = z.infer<typeof deepsetPipelineSchema>

const listResponseSchema = z.object({ data: z.array(deepsetPipelineSchema) })
const yamlResponseSchema = z.object({ query_yaml: z.string() })

export class DeepsetManagementClient {
  private readonly config: HaystackManagementConfig
  private readonly fetchFn: typeof fetch

  constructor(config: HaystackManagementConfig, deps: HaystackManagementDeps = {}) {
    this.config = config
    this.fetchFn = deps.fetchFn ?? globalThis.fetch
  }

  /** Create a pipeline. `dryRun` validates the YAML without persisting. Returns
   *  nothing — the 201 body is just `{name}`. */
  async createPipeline(input: { name: string; queryYaml: string; dryRun?: boolean }): Promise<void> {
    const query = input.dryRun ? '?dry_run=true' : ''
    const res = await this.send(`${this.pipelinesUrl()}${query}`, {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify({ name: input.name, query_yaml: input.queryYaml, deepset_cloud_version: 'v2' }),
    })
    await res.text()
  }

  /** Deploy (activate) a created pipeline. Returns the pipeline with its (in-progress) status. */
  async deployPipeline(name: string): Promise<DeepsetPipeline> {
    const res = await this.send(`${this.pipelineUrl(name)}/deploy`, { method: 'POST', headers: this.jsonHeaders() })
    return deepsetPipelineSchema.parse(await res.json())
  }

  /** Live status of a single pipeline. */
  async getPipeline(name: string): Promise<DeepsetPipeline> {
    const res = await this.send(this.pipelineUrl(name), { headers: this.jsonHeaders() })
    return deepsetPipelineSchema.parse(await res.json())
  }

  /** All pipelines in the workspace. */
  async listPipelines(limit = 100): Promise<DeepsetPipeline[]> {
    const res = await this.send(`${this.pipelinesUrl()}?limit=${limit}`, { headers: this.jsonHeaders() })
    return listResponseSchema.parse(await res.json()).data
  }

  /** The `query_yaml` of an existing pipeline — used to clone a curated template. */
  async getPipelineYaml(name: string): Promise<string> {
    const res = await this.send(`${this.pipelineUrl(name)}/yaml`, { headers: this.jsonHeaders() })
    return yamlResponseSchema.parse(await res.json()).query_yaml
  }

  /** Stop a running pipeline (teardown step before delete). */
  async undeployPipeline(name: string): Promise<void> {
    const res = await this.send(`${this.pipelineUrl(name)}/undeploy`, { method: 'POST', headers: this.jsonHeaders() })
    await res.text()
  }

  /** Permanently remove a pipeline. */
  async deletePipeline(name: string): Promise<void> {
    const res = await this.send(this.pipelineUrl(name), { method: 'DELETE', headers: this.jsonHeaders() })
    await res.text()
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(url, init)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new DeepsetManagementError(res.status, res.statusText, body)
    }
    return res
  }

  private workspaceBaseUrl(): string {
    const base = this.config.haystackBaseUrl.replace(/\/$/, '')
    return `${base}/api/v1/workspaces/${this.config.haystackWorkspace}`
  }

  private pipelinesUrl(): string {
    return `${this.workspaceBaseUrl()}/pipelines`
  }

  private pipelineUrl(name: string): string {
    return `${this.pipelinesUrl()}/${encodeURIComponent(name)}`
  }

  private authHeaders(): Record<string, string> {
    return this.config.haystackApiKey ? { authorization: `Bearer ${this.config.haystackApiKey}` } : {}
  }

  private jsonHeaders(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json', ...this.authHeaders() }
  }
}
