/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { DatabaseProvider } from '@/contexts'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { workspacesTable } from '@/db/tables'
import { useActiveWorkspace } from '@/lib/active-workspace'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { useScopePickerEnabled } from './use-scope-picker-enabled'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const Probe = () => {
  const enabled = useScopePickerEnabled()
  // Surface the resolved workspace id alongside the boolean so tests can wait
  // for the underlying query to settle before reading `enabled` — otherwise the
  // initial-render `false` (workspace pending) is indistinguishable from the
  // intentional `false` (resolved-as-personal).
  const workspace = useActiveWorkspace()
  return (
    <>
      <span data-testid="workspace-id">{workspace?.id ?? 'none'}</span>
      <span data-testid="enabled">{String(enabled)}</span>
    </>
  )
}

const seedSharedWorkspace = async () => {
  await getDb().insert(workspacesTable).values({ id: otherWsId, name: 'Acme', isPersonal: 0, ownerUserId: null })
}

const renderAt = (route: string) =>
  renderWithReactivity(<Probe />, {
    route,
    routePath: '/*',
    tables: ['workspaces'],
    wrapper: DbWrapper,
  })

const waitForWorkspace = (expectedId: string) =>
  waitForElement(() =>
    screen.getByTestId('workspace-id').textContent === expectedId ? screen.getByTestId('workspace-id') : null,
  )

describe('useScopePickerEnabled', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
    // Reset the persisted config store between tests so the
    // `allowUserScopedResources` flag from one case doesn't leak into the next.
    useConfigStore.setState({ config: {} })
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
    // Reset on the way out too — the last test in the file leaves the store
    // mutated, which can flip downstream files (skills-view, etc.) into the
    // `allowUserScopedResources: false` branch when bun's randomize picks an
    // order that lands them after this suite.
    useConfigStore.setState({ config: {} })
  })

  it('returns false in a personal workspace (single-member; the workspace/user split is meaningless)', async () => {
    // The default fixture seeds a personal workspace under `wsId` — visiting
    // its unprefixed URL resolves the active workspace as personal.
    renderAt('/skills')
    await waitForWorkspace(wsId)
    expect(screen.getByTestId('enabled').textContent).toBe('false')
  })

  it('returns true in a shared workspace when allowUserScopedResources is on (default)', async () => {
    await seedSharedWorkspace()
    renderAt(`/w/${otherWsId}/skills`)
    await waitForWorkspace(otherWsId)
    expect(screen.getByTestId('enabled').textContent).toBe('true')
  })

  it('returns false when allowUserScopedResources is disabled by the deployment', async () => {
    await seedSharedWorkspace()
    useConfigStore.setState({ config: { allowUserScopedResources: false } })

    renderAt(`/w/${otherWsId}/skills`)
    await waitForWorkspace(otherWsId)
    expect(screen.getByTestId('enabled').textContent).toBe('false')
  })

  it('treats an absent allowUserScopedResources as allowed (matches BE default)', async () => {
    await seedSharedWorkspace()
    useConfigStore.setState({ config: {} })

    renderAt(`/w/${otherWsId}/skills`)
    await waitForWorkspace(otherWsId)
    expect(screen.getByTestId('enabled').textContent).toBe('true')
  })
})
