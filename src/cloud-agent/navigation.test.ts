/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { cloudAgentRoute, legacyCloudAgentLocation } from './navigation'

it('restores agent chat, artifact and connection surfaces from browser history', () => {
  expect(cloudAgentRoute(new URLSearchParams('agent=a&conversation=c'))).toMatchObject({
    tab: 'agents',
    agentId: 'a',
    conversationId: 'c',
    editing: false,
    creating: false,
  })
  expect(cloudAgentRoute(new URLSearchParams('artifact=file'))).toMatchObject({
    tab: 'artifacts',
    artifactId: 'file',
    agentId: null,
    conversationId: null,
  })
  expect(cloudAgentRoute(new URLSearchParams('tab=connections'))).toMatchObject({ tab: 'connections' })
  expect(cloudAgentRoute(new URLSearchParams('agent=a&edit=agent'))).toMatchObject({ editing: true, creating: false })
  expect(cloudAgentRoute(new URLSearchParams('tab=agents&create=agent'))).toMatchObject({ creating: true })
})

it('ignores stale editor and conversation parameters when opening an artifact link', () => {
  expect(
    cloudAgentRoute(new URLSearchParams('artifact=file&agent=a&conversation=c&create=agent&edit=agent')),
  ).toMatchObject({ tab: 'artifacts', agentId: null, conversationId: null, editing: false, creating: false })
})

it('opens Connections after the cloud OAuth callback and rejects unknown result values', () => {
  expect(cloudAgentRoute(new URLSearchParams('cloudOAuth=connected'))).toMatchObject({
    tab: 'connections',
    oauthResult: 'connected',
  })
  expect(cloudAgentRoute(new URLSearchParams('cloudOAuth=failed'))).toMatchObject({
    tab: 'connections',
    oauthResult: 'failed',
  })
  expect(cloudAgentRoute(new URLSearchParams('cloudOAuth=unknown'))).toMatchObject({
    tab: 'agents',
    oauthResult: null,
  })
})

it('redirects old artifact links to the independent library and removes stale agent state', () => {
  expect(legacyCloudAgentLocation(new URLSearchParams('tab=artifacts'))).toBe('/artifacts')
  expect(
    legacyCloudAgentLocation(new URLSearchParams('artifact=a%2Fb&agent=old&conversation=chat&create=agent&edit=agent')),
  ).toBe('/artifacts?artifact=a%2Fb')
})

it('preserves durable chat and OAuth callback targets in ordinary settings routes', () => {
  expect(legacyCloudAgentLocation(new URLSearchParams('agent=a&conversation=c'))).toBe('/chats/c?cloudAgent=a')
  expect(legacyCloudAgentLocation(new URLSearchParams('create=agent'))).toBe('/settings/agents?create=agent')
  expect(legacyCloudAgentLocation(new URLSearchParams('tab=connections&cloudOAuth=connected'))).toBe(
    '/settings/connections?cloudOAuth=connected',
  )
})
