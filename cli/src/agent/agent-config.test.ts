/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentConfigPath, emptyAgentConfig, loadAgentConfig, parseAgentConfig } from './agent-config.ts'

const skill = { name: 'triage', description: 'Triage a ticket', instruction: 'Do the thing.' }

const writeConfig = async (contents: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-agent-config-'))
  const path = join(dir, 'agent.json')
  await writeFile(path, contents, 'utf8')
  return path
}

describe('parseAgentConfig', () => {
  it('accepts a config with skills and both transports', () => {
    const parsed = parseAgentConfig({
      version: 1,
      skills: [skill],
      mcpServers: [
        { id: 'docs', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], trustTools: true },
        {
          id: 'api',
          transport: 'http',
          url: 'https://mcp.example/sse',
          headers: { authorization: 'x' },
          trustTools: false,
        },
      ],
    })

    expect(parsed?.skills).toEqual([skill])
    expect(parsed?.mcpServers.map((server) => server.id)).toEqual(['docs', 'api'])
    expect(parsed?.mcpServers[0]?.trustTools).toBe(true)
  })

  it('defaults both collections to empty', () => {
    expect(parseAgentConfig({ version: 1 })).toEqual(emptyAgentConfig)
  })

  it.each([
    ['an unknown version', { version: 2 }],
    ['a non-object document', 'nope'],
    ['a skill missing its instruction', { version: 1, skills: [{ name: 'a', description: 'b' }] }],
    ['a blank skill name', { version: 1, skills: [{ ...skill, name: '  ' }] }],
    ['an unknown transport', { version: 1, mcpServers: [{ id: 'x', transport: 'carrier-pigeon', trustTools: false }] }],
    ['stdio without a command', { version: 1, mcpServers: [{ id: 'x', transport: 'stdio', trustTools: false }] }],
    ['http without a url', { version: 1, mcpServers: [{ id: 'x', transport: 'http', trustTools: false }] }],
    [
      'non-string args',
      { version: 1, mcpServers: [{ id: 'x', transport: 'stdio', command: 'c', args: [1], trustTools: false }] },
    ],
  ])('rejects %s', (_label, document) => {
    expect(parseAgentConfig(document)).toBeNull()
  })

  it('rejects a config missing trustTools rather than assuming either answer', () => {
    // Defaulting to false would be safe but silent, and an operator who forgot
    // the field has not decided anything. Make them say it.
    expect(parseAgentConfig({ version: 1, mcpServers: [{ id: 'x', transport: 'stdio', command: 'c' }] })).toBeNull()
  })

  it('rejects duplicate server ids', () => {
    // Ids namespace tool names, so two servers sharing one silently shadow each
    // other's tools with no way to tell which answered.
    const document = {
      version: 1,
      mcpServers: [
        { id: 'dup', transport: 'stdio', command: 'a', trustTools: false },
        { id: 'dup', transport: 'stdio', command: 'b', trustTools: false },
      ],
    }
    expect(parseAgentConfig(document)).toBeNull()
  })

  it('rejects plain http to a non-loopback host but allows it locally', () => {
    const remote = {
      version: 1,
      mcpServers: [{ id: 'x', transport: 'http', url: 'http://mcp.example', trustTools: false }],
    }
    const local = {
      version: 1,
      mcpServers: [{ id: 'x', transport: 'http', url: 'http://127.0.0.1:3000', trustTools: false }],
    }

    expect(parseAgentConfig(remote)).toBeNull()
    expect(parseAgentConfig(local)).not.toBeNull()
  })

  it('rejects the whole document when one server is malformed', () => {
    // Partial acceptance would start an agent that looks healthy while quietly
    // missing tools the team depends on.
    const document = {
      version: 1,
      mcpServers: [
        { id: 'good', transport: 'stdio', command: 'a', trustTools: false },
        { id: 'bad', transport: 'stdio', trustTools: false },
      ],
    }
    expect(parseAgentConfig(document)).toBeNull()
  })
})

describe('loadAgentConfig', () => {
  it('returns the empty config when no file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-agent-config-'))
    expect(await loadAgentConfig({ THUNDERBOLT_AGENT_CONFIG: join(dir, 'absent.json') })).toEqual(emptyAgentConfig)
  })

  it('reads a valid file', async () => {
    const path = await writeConfig(JSON.stringify({ version: 1, skills: [skill] }))
    expect((await loadAgentConfig({ THUNDERBOLT_AGENT_CONFIG: path })).skills).toEqual([skill])
  })

  it('throws on a present-but-invalid file rather than starting without it', async () => {
    const path = await writeConfig(JSON.stringify({ version: 9 }))
    await expect(loadAgentConfig({ THUNDERBOLT_AGENT_CONFIG: path })).rejects.toThrow('Invalid agent config')
  })

  it('throws on malformed JSON', async () => {
    const path = await writeConfig('{ not json')
    await expect(loadAgentConfig({ THUNDERBOLT_AGENT_CONFIG: path })).rejects.toThrow('Invalid agent config')
  })

  it('falls back to the state root when the env override is unset', () => {
    expect(agentConfigPath({ THUNDERBOLT_HOME: '/tmp/state' })).toBe('/tmp/state/agent.json')
  })
})
