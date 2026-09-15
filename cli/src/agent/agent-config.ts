/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Agent-owned skills and MCP servers for a deployed `acp serve`.
 *
 * Until now the only source of skills was `readWireSkills(params._meta)` — the
 * connecting client sends its own. That is the wrong direction for a shared
 * agent: the point of hosting one is that a team configures it once instead of
 * each person configuring their own client. This file is the other direction.
 *
 * Read once at startup from `THUNDERBOLT_AGENT_CONFIG`, or `agent.json` under
 * the state root. Absent means absent — a plain `acp serve` behaves exactly as
 * it did before.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillDefinition } from '../../../shared/agent-core/skills.ts'
import { hasExactKeys, isNonblankString, isRecord, parseJson } from '../lib/json.ts'
import { thunderboltHomeDir } from '../paths.ts'

export type McpServerConfig = {
  readonly id: string
  readonly transport: 'stdio' | 'http'
  /** stdio only: executable and arguments. */
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** http only: endpoint, plus any auth headers. */
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Allow this server's tools to run without a per-call permission prompt.
   *
   * Off by default, and deliberately per-server rather than global: on a shared
   * agent every prompt is answered by whichever teammate happens to be
   * connected, so a blanket auto-allow means one person's session can silently
   * authorise a write on behalf of the whole team. Marking a read-only
   * documentation server trusted is reasonable; marking one that can write to
   * production is a decision an operator should make deliberately, per server.
   */
  readonly trustTools: boolean
}

export type AgentConfig = {
  readonly version: 1
  readonly skills: readonly SkillDefinition[]
  readonly mcpServers: readonly McpServerConfig[]
}

export const emptyAgentConfig: AgentConfig = Object.freeze({ version: 1, skills: [], mcpServers: [] })

/** Default location when `THUNDERBOLT_AGENT_CONFIG` is unset. */
export const agentConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.THUNDERBOLT_AGENT_CONFIG || join(thunderboltHomeDir(env), 'agent.json')

const parseStringRecord = (value: unknown): Record<string, string> | null => {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

const parseSkill = (value: unknown): SkillDefinition | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['name', 'description', 'instruction'])) return null
  if (!isNonblankString(value.name) || !isNonblankString(value.description)) return null
  if (!isNonblankString(value.instruction)) return null
  return { name: value.name, description: value.description, instruction: value.instruction }
}

const parseMcpServer = (value: unknown): McpServerConfig | null => {
  if (!isRecord(value) || !isNonblankString(value.id)) return null
  if (typeof value.trustTools !== 'boolean') return null

  const env = parseStringRecord(value.env)
  const headers = parseStringRecord(value.headers)
  if (env === null || headers === null) return null

  if (value.transport === 'stdio') {
    if (!isNonblankString(value.command)) return null
    const args = value.args === undefined ? [] : value.args
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return null
    return { id: value.id, transport: 'stdio', command: value.command, args, env, trustTools: value.trustTools }
  }

  if (value.transport === 'http') {
    if (!isNonblankString(value.url)) return null
    // Refuse plain http to anywhere but loopback: a served agent runs on a host
    // whose network is not the operator's laptop, and MCP headers routinely
    // carry bearer tokens.
    const parsed = safeUrl(value.url)
    if (parsed === null) return null
    if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) return null
    return { id: value.id, transport: 'http', url: value.url, headers, trustTools: value.trustTools }
  }

  return null
}

const safeUrl = (value: string): URL | null => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')

/**
 * Validate a parsed config document.
 *
 * Returns null rather than a partial config on any problem: a served agent that
 * silently starts with half its MCP servers looks healthy while quietly missing
 * the tools a team depends on. Failing the whole file makes the misconfiguration
 * obvious at startup.
 */
export const parseAgentConfig = (value: unknown): AgentConfig | null => {
  if (!isRecord(value) || value.version !== 1) return null

  const rawSkills = value.skills === undefined ? [] : value.skills
  const rawServers = value.mcpServers === undefined ? [] : value.mcpServers
  if (!Array.isArray(rawSkills) || !Array.isArray(rawServers)) return null

  const skills: SkillDefinition[] = []
  for (const entry of rawSkills) {
    const skill = parseSkill(entry)
    if (skill === null) return null
    skills.push(skill)
  }

  const mcpServers: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const entry of rawServers) {
    const server = parseMcpServer(entry)
    if (server === null || seen.has(server.id)) return null
    seen.add(server.id)
    mcpServers.push(server)
  }

  return { version: 1, skills, mcpServers }
}

/**
 * Load the agent config, or {@link emptyAgentConfig} when the file does not
 * exist. A present-but-invalid file throws: an operator who wrote a config meant
 * it to take effect, and starting without it would be a silent downgrade.
 */
export const loadAgentConfig = async (env: NodeJS.ProcessEnv = process.env): Promise<AgentConfig> => {
  const path = agentConfigPath(env)
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) return emptyAgentConfig
    throw error
  }

  const invalid = new Error(`Invalid agent config at ${path}`)
  const parsed = parseAgentConfig(parseJson(contents, invalid))
  if (parsed === null) throw invalid
  return parsed
}

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
