/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SiGithub, SiLinear, SiRender } from '@icons-pack/react-simple-icons'
import { Blocks } from 'lucide-react'
import { describe, expect, it } from 'bun:test'
import { getMcpToolDisplay } from './mcp-tool-display'

const servers = {
  render: { id: 'r1', name: 'Render', url: 'https://render.com' },
  render_2: { id: 'r2', name: 'Render Staging', url: 'https://render.com' },
  linear: { id: 'l1', name: 'My Linear', url: 'https://mcp.linear.app/sse' },
  github: { id: 'g1', name: 'Copilot', url: 'https://api.githubcopilot.com/mcp' },
}

describe('getMcpToolDisplay', () => {
  it('resolves the server by sanitized prefix and de-prefixes the tool name', () => {
    const result = getMcpToolDisplay('render_list_services', servers)
    expect(result.serverName).toBe('Render')
    expect(result.displayName).toBe('List Services')
    expect(result.icon.icon).toBe(SiRender)
  })

  it('prefers the longest matching prefix (render_2 over render)', () => {
    const result = getMcpToolDisplay('render_2_list_services', servers)
    expect(result.serverName).toBe('Render Staging')
    expect(result.displayName).toBe('List Services')
  })

  it('still resolves render when the tool name only matches the short prefix', () => {
    const result = getMcpToolDisplay('render_2things', servers)
    // "render_2things" starts with "render_" but not "render_2_", so → render
    expect(result.serverName).toBe('Render')
    expect(result.displayName).toBe('2things')
  })

  it('resolves brand icons via the server url incl. domain aliases', () => {
    expect(getMcpToolDisplay('linear_create_issue', servers).icon.icon).toBe(SiLinear)
    expect(getMcpToolDisplay('github_get_repo', servers).icon.icon).toBe(SiGithub)
  })

  it('prefers an explicit MCP tool title over the derived name', () => {
    const result = getMcpToolDisplay('render_list_services', servers, 'Custom Title')
    expect(result.displayName).toBe('Custom Title')
    expect(result.serverName).toBe('Render')
  })

  it('falls back gracefully when no map is provided (old messages)', () => {
    const result = getMcpToolDisplay('render_list_services')
    expect(result.serverName).toBeUndefined()
    expect(result.displayName).toBe('Render List Services')
    expect(result.icon.icon).toBe(Blocks)
  })

  it('falls back gracefully when the prefix is unknown', () => {
    const result = getMcpToolDisplay('unknown_do_thing', servers)
    expect(result.serverName).toBeUndefined()
    expect(result.displayName).toBe('Unknown Do Thing')
    expect(result.icon.icon).toBe(Blocks)
  })

  it('prettifies and truncates to ~25 chars matching built-in behavior', () => {
    const result = getMcpToolDisplay('render_a_very_long_tool_name_indeed', servers)
    expect(result.displayName.length).toBeLessThanOrEqual(25)
  })
})
