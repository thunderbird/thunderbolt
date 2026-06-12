/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SiGithub, SiLinear, SiRender } from '@icons-pack/react-simple-icons'
import { Blocks } from 'lucide-react'
import { describe, expect, it } from 'bun:test'
import { getMcpToolDisplay } from './mcp-tool-display'

// Keyed by the exact namespaced tool name → owning server + bare tool name.
// `render_2_deploy` is owned by the `render` server (its bare tool is `2_deploy`),
// while a separate `render_2` server owns `render_2_list_services`: the textual
// prefixes overlap, which is exactly what the old longest-prefix heuristic
// mislabeled.
const tools = {
  render_list_services: { name: 'Render', url: 'https://render.com', toolName: 'list_services' },
  render_2_deploy: { name: 'Render', url: 'https://render.com', toolName: '2_deploy' },
  render_2_list_services: { name: 'Render Staging', url: 'https://render.com', toolName: 'list_services' },
  linear_create_issue: { name: 'My Linear', url: 'https://mcp.linear.app/sse', toolName: 'create_issue' },
  github_get_repo: { name: 'Copilot', url: 'https://api.githubcopilot.com/mcp', toolName: 'get_repo' },
}

describe('getMcpToolDisplay', () => {
  it('resolves the server by exact tool name and de-namespaces the tool name', () => {
    const result = getMcpToolDisplay('render_list_services', tools)
    expect(result.serverName).toBe('Render')
    expect(result.displayName).toBe('List Services')
    expect(result.icon.icon).toBe(SiRender)
  })

  it('attributes overlapping prefixes to their exact owner (the render/render_2 bug)', () => {
    // `render_2_deploy` belongs to the `render` server; longest-prefix matching
    // wrongly attributed it to `render_2`. Exact lookup keeps each tool's owner.
    const deploy = getMcpToolDisplay('render_2_deploy', tools)
    expect(deploy.serverName).toBe('Render')
    expect(deploy.displayName).toBe('2 Deploy')

    const listServices = getMcpToolDisplay('render_2_list_services', tools)
    expect(listServices.serverName).toBe('Render Staging')
    expect(listServices.displayName).toBe('List Services')
  })

  it('resolves brand icons via the server url incl. domain aliases', () => {
    expect(getMcpToolDisplay('linear_create_issue', tools).icon.icon).toBe(SiLinear)
    expect(getMcpToolDisplay('github_get_repo', tools).icon.icon).toBe(SiGithub)
  })

  it('prefers an explicit MCP tool title over the derived name', () => {
    const result = getMcpToolDisplay('render_list_services', tools, 'Custom Title')
    expect(result.displayName).toBe('Custom Title')
    expect(result.serverName).toBe('Render')
  })

  it('falls back gracefully when no map is provided (old messages)', () => {
    const result = getMcpToolDisplay('render_list_services')
    expect(result.serverName).toBeUndefined()
    expect(result.displayName).toBe('Render List Services')
    expect(result.icon.icon).toBe(Blocks)
  })

  it('falls back gracefully when the tool is not in the map (unknown / legacy shape)', () => {
    const result = getMcpToolDisplay('unknown_do_thing', tools)
    expect(result.serverName).toBeUndefined()
    expect(result.displayName).toBe('Unknown Do Thing')
    expect(result.icon.icon).toBe(Blocks)
  })

  it('prettifies and truncates to ~25 chars matching built-in behavior', () => {
    const longTool = {
      a_very_long_tool_name_indeed: {
        name: 'Render',
        url: 'https://render.com',
        toolName: 'a_very_long_tool_name_indeed',
      },
    }
    const result = getMcpToolDisplay('a_very_long_tool_name_indeed', longTool)
    expect(result.displayName.length).toBeLessThanOrEqual(25)
  })
})
