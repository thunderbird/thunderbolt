/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { workspacesTable } from '@/db/tables'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from '@/dal/test-utils'
import type { Workspace } from '@/dal'
import {
  resetTestTrustDomain,
  renderWithReactivity,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import {
  crossWorkspaceSubPath,
  stripWorkspacePrefix,
  toWorkspaceUrl,
  useActiveWorkspace,
  useActiveWorkspaceId,
  useWorkspaceUrl,
} from './active-workspace'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'

const personalWorkspace: Workspace = {
  id: wsId,
  name: 'Personal',
  slug: null,
  icon: null,
  isPersonal: 1,
  ownerUserId: 'test-user',
  createdAt: null,
  updatedAt: null,
}

const sharedWorkspace: Workspace = {
  id: otherWsId,
  name: 'Acme',
  slug: null,
  icon: null,
  isPersonal: 0,
  ownerUserId: 'test-user',
  createdAt: null,
  updatedAt: null,
}

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

describe('toWorkspaceUrl', () => {
  it('returns the bare sub-path for personal workspaces', () => {
    expect(toWorkspaceUrl(personalWorkspace, '/chats/new')).toBe('/chats/new')
    expect(toWorkspaceUrl(personalWorkspace, '/settings/preferences')).toBe('/settings/preferences')
  })

  it('prefixes the workspace id for shared workspaces', () => {
    expect(toWorkspaceUrl(sharedWorkspace, '/chats/new')).toBe(`/w/${otherWsId}/chats/new`)
  })

  it('normalizes paths without a leading slash', () => {
    expect(toWorkspaceUrl(sharedWorkspace, 'tasks')).toBe(`/w/${otherWsId}/tasks`)
    expect(toWorkspaceUrl(personalWorkspace, 'tasks')).toBe('/tasks')
  })

  it('strips an existing workspace prefix before re-prefixing', () => {
    expect(toWorkspaceUrl(sharedWorkspace, `/w/${wsId}/chats/abc`)).toBe(`/w/${otherWsId}/chats/abc`)
    expect(toWorkspaceUrl(personalWorkspace, `/w/${otherWsId}/chats/abc`)).toBe('/chats/abc')
  })
})

describe('stripWorkspacePrefix', () => {
  it('drops the /w/<id> segment', () => {
    expect(stripWorkspacePrefix(`/w/${otherWsId}/chats/abc`)).toBe('/chats/abc')
    expect(stripWorkspacePrefix(`/w/${otherWsId}`)).toBe('/')
  })

  it('passes through unprefixed paths', () => {
    expect(stripWorkspacePrefix('/chats/abc')).toBe('/chats/abc')
    expect(stripWorkspacePrefix('/')).toBe('/')
  })
})

describe('crossWorkspaceSubPath', () => {
  it('collapses chat-detail paths to /chats/new across the switch', () => {
    expect(crossWorkspaceSubPath(`/w/${otherWsId}/chats/abc-123`)).toBe('/chats/new')
    expect(crossWorkspaceSubPath('/chats/abc-123')).toBe('/chats/new')
    // The bare /chats route is also collapsed for consistency.
    expect(crossWorkspaceSubPath(`/w/${otherWsId}/chats`)).toBe('/chats/new')
  })

  it('passes through non-chat paths', () => {
    expect(crossWorkspaceSubPath(`/w/${otherWsId}/settings/preferences`)).toBe('/settings/preferences')
    expect(crossWorkspaceSubPath('/tasks')).toBe('/tasks')
    expect(crossWorkspaceSubPath(`/w/${otherWsId}/`)).toBe('/')
  })
})

describe('useActiveWorkspaceId reactivity', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  const ActiveIdProbe = () => {
    const id = useActiveWorkspaceId()
    // Render the resolved id as text so waitForElement can poll for it.
    // Returns null while the live query is still loading.
    if (!id) {
      return null
    }
    return <span data-testid={`active-id-${id}`}>{id}</span>
  }

  it('falls back to the personal workspace when no URL prefix', async () => {
    renderWithReactivity(<ActiveIdProbe />, {
      route: '/chats/new',
      routePath: '*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })
    await waitForElement(() => screen.queryByTestId(`active-id-${wsId}`))
    expect(screen.getByTestId(`active-id-${wsId}`)).toBeInTheDocument()
  })

  it('surfaces the URL-encoded id immediately even before the workspace row materializes', async () => {
    renderWithReactivity(<ActiveIdProbe />, {
      route: `/w/${otherWsId}/chats/new`,
      routePath: '*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })
    // No row inserted for `otherWsId` — the URL id should still surface.
    await waitForElement(() => screen.queryByTestId(`active-id-${otherWsId}`))
    expect(screen.getByTestId(`active-id-${otherWsId}`)).toBeInTheDocument()
  })

  it('resolves to the URL-encoded workspace id when /w/<id>/ is present', async () => {
    const db = getDb()
    await db.insert(workspacesTable).values({
      id: otherWsId,
      name: 'Acme',
      isPersonal: 0,
      ownerUserId: 'someone-else',
    })

    renderWithReactivity(<ActiveIdProbe />, {
      route: `/w/${otherWsId}/chats/new`,
      routePath: '*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })
    await waitForElement(() => screen.queryByTestId(`active-id-${otherWsId}`))
    expect(screen.getByTestId(`active-id-${otherWsId}`)).toBeInTheDocument()
  })
})

describe('useActiveWorkspace', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  const WorkspaceProbe = () => {
    const ws = useActiveWorkspace()
    if (!ws) {
      return null
    }
    return <span data-testid={`ws-${ws.id}-personal-${ws.isPersonal}`}>{ws.name}</span>
  }

  it('returns the personal workspace row when no URL prefix', async () => {
    renderWithReactivity(<WorkspaceProbe />, {
      route: '/chats/new',
      routePath: '*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })
    await waitForElement(() => screen.queryByTestId(`ws-${wsId}-personal-1`))
    expect(screen.getByTestId(`ws-${wsId}-personal-1`)).toBeInTheDocument()
  })

  it('returns the by-id workspace row when /w/<id>/ is present', async () => {
    const db = getDb()
    await db.insert(workspacesTable).values({
      id: otherWsId,
      name: 'Acme',
      isPersonal: 0,
      ownerUserId: 'someone-else',
    })

    renderWithReactivity(<WorkspaceProbe />, {
      route: `/w/${otherWsId}/chats/new`,
      routePath: '*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })
    await waitForElement(() => screen.queryByTestId(`ws-${otherWsId}-personal-0`))
    expect(screen.getByTestId(`ws-${otherWsId}-personal-0`)).toBeInTheDocument()
  })
})

describe('useWorkspaceUrl', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  const UrlProbe = ({ path }: { path: string }) => {
    const url = useWorkspaceUrl(path)
    const ws = useActiveWorkspace()
    // Only render once the active workspace has resolved, so the assertion
    // doesn't race with the live query loading state.
    if (!ws) {
      return null
    }
    return <span data-testid={`url-${encodeURIComponent(url)}`}>{url}</span>
  }

  it('keeps paths unprefixed when active workspace is personal', async () => {
    const testId = `url-${encodeURIComponent('/tasks')}`
    renderWithReactivity(<UrlProbe path="/tasks" />, {
      route: '/chats/new',
      routePath: '*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })
    await waitForElement(() => screen.queryByTestId(testId))
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  it('prefixes /w/<id> when active workspace is shared', async () => {
    const db = getDb()
    await db.insert(workspacesTable).values({
      id: otherWsId,
      name: 'Acme',
      isPersonal: 0,
      ownerUserId: 'someone-else',
    })
    const testId = `url-${encodeURIComponent(`/w/${otherWsId}/tasks`)}`

    renderWithReactivity(<UrlProbe path="/tasks" />, {
      route: `/w/${otherWsId}/chats/new`,
      routePath: '*',
      tables: ['workspaces'],
      wrapper: DbWrapper,
    })
    await waitForElement(() => screen.queryByTestId(testId))
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })
})
