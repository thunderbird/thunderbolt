/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { CloudMcpLibraryEntry } from '@/cloud-agent/connection-library'
import type { McpServer } from '@/types'
import { resolveAgentMcps, selectedAgentMcps } from './agent-library-selection'

const entry = (id: string, cloudConnectionId?: string, ready = false): CloudMcpLibraryEntry => ({
  server: { id, name: id, type: 'http', enabled: 1 } as McpServer,
  source: { kind: 'mcp', id, name: id, url: 'https://mcp.example.com' },
  cloudConnectionId,
  ready,
  eligible: true,
  definitionChanged: false,
})

describe('portable agent MCP selection', () => {
  it('keeps a local-only selection without manufacturing cloud authorization', () => {
    expect(
      resolveAgentMcps({ mcpServers: [{ sourceId: 'local', name: 'Local' }], connectionIds: [] }, [entry('local')]),
    ).toEqual({
      mcpServers: [{ sourceId: 'local', name: 'local' }],
      connectionIds: [],
    })
  })

  it('resolves authorized cloud bindings for selected sources and does not grant unselected sources', () => {
    expect(
      resolveAgentMcps({ mcpServers: [{ sourceId: 'selected', name: 'Selected' }], connectionIds: [] }, [
        entry('selected', 'selected-cloud', true),
        entry('other', 'other-cloud', true),
      ]),
    ).toEqual({ mcpServers: [{ sourceId: 'selected', name: 'selected' }], connectionIds: ['selected-cloud'] })
  })

  it('upgrades a legacy selection and preserves the portable reference after cloud access is unavailable', () => {
    const entries = [entry('library', 'cloud', false)]
    expect(selectedAgentMcps({ connectionIds: ['cloud'] }, entries)).toEqual([{ sourceId: 'library', name: 'library' }])
    expect(resolveAgentMcps({ connectionIds: ['cloud'] }, entries)).toEqual({
      mcpServers: [{ sourceId: 'library', name: 'library' }],
      connectionIds: [],
    })
  })

  it('preserves selected references missing on this device and older unlinked cloud connections', () => {
    const config = { mcpServers: [{ sourceId: 'missing', name: 'Another device' }], connectionIds: ['legacy'] }
    expect(resolveAgentMcps(config, [])).toEqual(config)
  })
})
