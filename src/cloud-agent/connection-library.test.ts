/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { McpServer } from '@/types'
import { connectionFixture } from './connection-library-fixture'
import {
  cloudConfigFromLibrary,
  findCloudLibraryBinding,
  getCloudMcpBinding,
  isCloudPublicEndpoint,
} from './connection-library'

const server: McpServer = {
  id: 'library-mcp',
  name: 'Tools',
  type: 'http',
  url: 'https://tools.example.com/mcp',
  enabled: 0,
  args: null,
  command: null,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
  userId: null,
}

describe('Connections library cloud bindings', () => {
  it('uses stable source identity, never an identical URL or name, and keeps local enablement independent', () => {
    expect(getCloudMcpBinding(server, [connectionFixture()]).reason).toBe('unbound')
    expect(getCloudMcpBinding(server, [connectionFixture('different-library-item')]).reason).toBe('unbound')
    const bound = getCloudMcpBinding(server, [connectionFixture(server.id)])
    expect(bound.ready).toBe(true)
    expect(bound.cloudConnectionId).toBe('cloud-connection')
  })
  it('keeps unsupported transports and local endpoints unavailable', () => {
    for (const type of ['stdio', 'sse', 'iroh'] as const) {
      expect(getCloudMcpBinding({ ...server, type }, []).reason).toBe('transport')
    }
    for (const url of [
      'http://tools.example.com/mcp',
      'https://localhost/mcp',
      'https://10.0.0.1/mcp',
      'https://127.1/mcp',
      'https://[::1]/mcp',
      'https://192.168.0.1/mcp',
      'https://100.64.1.2/mcp',
      'https://host.local/mcp',
      'https://user:secret@tools.example.com/mcp',
    ]) {
      expect(isCloudPublicEndpoint(url)).toBe(false)
    }
    expect(isCloudPublicEndpoint(server.url!)).toBe(true)
  })
  it('requires explicit refresh after endpoint changes and readiness after authorization', () => {
    const connection = connectionFixture(server.id)
    expect(getCloudMcpBinding({ ...server, url: 'https://different.example.com/mcp' }, [connection])).toMatchObject({
      reason: 'changed',
      ready: false,
      definitionChanged: true,
    })
    expect(
      getCloudMcpBinding(server, [{ ...connection, record: { ...connection.record, enabled: false } }]).reason,
    ).toBe('disabled')
    expect(
      getCloudMcpBinding(server, [{ ...connection, record: { ...connection.record, status: 'needs-authorization' } }])
        .reason,
    ).toBe('authorization')
    expect(
      getCloudMcpBinding(server, [connection, { ...connection, record: { ...connection.record, id: 'another' } }])
        .reason,
    ).toBe('ambiguous')
    expect(
      getCloudMcpBinding(server, [
        connection,
        { ...connection, record: { ...connection.record, id: 'disabled-old-grant', enabled: false } },
      ]).cloudConnectionId,
    ).toBe(connection.record.id)
    expect(findCloudLibraryBinding({ kind: 'model', id: server.id }, [connection])).toBeUndefined()
  })
  it('snapshots the definition without device secrets, and never carries a token to a changed endpoint', () => {
    const source = { kind: 'mcp' as const, id: server.id, name: server.name, url: server.url! }
    const initial = cloudConfigFromLibrary(source)
    expect(initial.authentication).toEqual({ type: 'none' })
    expect(initial.libraryRef).toEqual({ kind: 'mcp', id: server.id })
    const previous = connectionFixture(server.id).config
    expect(cloudConfigFromLibrary({ ...source, name: 'Renamed' }, previous).authentication).toEqual(
      previous.authentication,
    )
    expect(
      cloudConfigFromLibrary({ ...source, url: 'https://other.example.com/mcp' }, previous).authentication,
    ).toEqual({ type: 'none' })
  })
})
