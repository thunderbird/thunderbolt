/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { act } from '@testing-library/react'
import { eq } from 'drizzle-orm'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { setArtifactPinned } from '@/dal/artifacts'
import { renameProjectArtifact, softDeleteProjectArtifact } from '@/dal/project-artifact-presentation'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { createAuthenticatedClient } from '@/lib/http'
import { resetMiniAppsForTesting } from '@/mini-apps/use-mini-apps'
import { resolveMiniAppIcon } from '@/mini-apps/registry'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { artifactId, toRemoteArtifact, type Artifact } from './artifact'
import { useArtifact, useArtifactPin, usePinnedArtifacts, usePresentedArtifact } from './use-artifacts'

const htmlId = artifactId({ kind: 'html', messageId: 'message', toolCallId: 'call' })
const remoteId = artifactId({ kind: 'remote', appId: 'finance' })
const remoteApp = {
  id: 'finance',
  name: 'Finance',
  description: '',
  icon: '',
  url: 'https://finance.example/app',
  origin: 'https://finance.example',
}
const htmlSnapshot: Artifact = {
  id: htmlId,
  reference: { kind: 'html', messageId: 'message', toolCallId: 'call' },
  title: 'Initial snapshot',
  chatThreadId: 'chat',
  source: { kind: 'html', html: '<p>Original</p>' },
}

/** Exercise real reactive SQL and HTTP parsing while controlling only the external registry response. */
const mountHook = <T>(
  useHook: () => T,
  response: () => Response | Promise<Response> = () => Response.json({ apps: [remoteApp] }),
) => {
  const snapshot: { current?: T } = {}
  const Probe = () => {
    snapshot.current = useHook()
    return createElement('div')
  }
  const httpClient = createAuthenticatedClient('https://backend.example', () => 'token', {
    fetch: Object.assign(async () => response(), { preconnect: () => {} }),
  })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(HttpClientProvider, { httpClient, children })
  const view = renderWithReactivity(createElement(Probe), {
    wrapper,
    tables: ['settings', 'chat_messages', 'chat_threads'],
  })
  return {
    ...view,
    read: (): T => {
      if (snapshot.current === undefined) {
        throw new Error('Hook has not rendered')
      }
      return snapshot.current
    },
  }
}

/** Flush the real query promises and batched React notifications without advancing registry deadlines. */
const settle = async () =>
  act(async () => {
    await getClock().tickAsync(200)
  })

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  resetMiniAppsForTesting()
  await resetTestDatabase()
  const db = getDb()
  await db.insert(chatThreadsTable).values({ id: 'chat', title: 'Original chat' })
  await db.insert(chatMessagesTable).values({
    id: 'message',
    role: 'assistant',
    chatThreadId: 'chat',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'render_html',
        toolCallId: 'call',
        state: 'output-available',
        input: { title: 'Generated app', html: '<p>Offline</p>' },
        output: { ok: true },
      },
    ],
  })
})
afterEach(resetMiniAppsForTesting)

describe('unified artifact queries', () => {
  it('removes an open remote source only after definitive registry removal, retaining it during outages', async () => {
    const snapshot = toRemoteArtifact({ ...remoteApp, icon: resolveMiniAppIcon('') })
    const unavailable = mountHook(
      () => usePresentedArtifact(snapshot),
      () => Response.json({ apps: [] }),
    )
    expect(unavailable.read()).toBe(snapshot)
    await settle()
    expect(unavailable.read()).toBeNull()
    unavailable.unmount()
    resetMiniAppsForTesting()
    const failed = mountHook(
      () => usePresentedArtifact(snapshot),
      () => new Response('offline', { status: 503 }),
    )
    await settle()
    expect(failed.read()).toBe(snapshot)
  })

  it('shares project renames and soft deletion with pins and an open frame', async () => {
    await setArtifactPinned(getDb(), htmlId, true)
    const view = mountHook(() => ({
      pins: usePinnedArtifacts(),
      open: usePresentedArtifact(htmlSnapshot),
    }))
    await settle()
    await renameProjectArtifact(getDb(), htmlId, 'Renamed in project')
    view.triggerChange(['settings'])
    await settle()
    expect(view.read().pins.artifacts[0]?.title).toBe('Renamed in project')
    expect(view.read().open?.title).toBe('Renamed in project')
    await softDeleteProjectArtifact(getDb(), htmlId)
    view.triggerChange(['settings'])
    await settle()
    expect(view.read().pins.artifacts).toEqual([])
    expect(view.read().open).toBeNull()
  })

  it('applies remote renames to pins, deep links and open frames while preserving the registry source', async () => {
    const snapshot = toRemoteArtifact({ ...remoteApp, icon: resolveMiniAppIcon('') })
    await setArtifactPinned(getDb(), remoteId, true)
    const view = mountHook(() => ({
      pins: usePinnedArtifacts(),
      full: useArtifact(remoteId),
      open: usePresentedArtifact(snapshot),
    }))
    await settle()
    await renameProjectArtifact(getDb(), remoteId, 'My finances')
    view.triggerChange(['settings'])
    await settle()
    for (const artifact of [view.read().pins.artifacts[0], view.read().full.artifact, view.read().open]) {
      expect(artifact).toMatchObject({
        id: remoteId,
        title: 'My finances',
        reference: snapshot.reference,
        source: snapshot.source,
      })
    }
  })

  it('updates an open snapshot from persistence and invalidates it on source deletion', async () => {
    const view = mountHook(() => usePresentedArtifact(htmlSnapshot))
    await settle()
    expect(view.read()?.title).toBe('Generated app')
    await getDb().update(chatMessagesTable).set({ deletedAt: '2026-01-01' }).where(eq(chatMessagesTable.id, 'message'))
    view.triggerChange(['chat_messages'])
    await settle()
    expect(view.read()).toBeNull()
  })

  it('retains a verified snapshot while a debounced save has not written its source', async () => {
    const pending: Artifact = {
      ...htmlSnapshot,
      id: artifactId({ kind: 'html', messageId: 'pending', toolCallId: 'call' }),
      reference: { kind: 'html', messageId: 'pending', toolCallId: 'call' },
    }
    const view = mountHook(() => usePresentedArtifact(pending))
    await settle()
    expect(view.read()).toBe(pending)
  })

  it('resolves generated and configured sources through the same identity API', async () => {
    const view = mountHook(() => ({ html: useArtifact(htmlId), remote: useArtifact(remoteId) }))
    await settle()
    expect(view.read().html).toMatchObject({ loading: false, failed: false, artifact: { id: htmlId } })
    expect(view.read().remote).toMatchObject({ loading: false, failed: false, artifact: { id: remoteId } })
  })

  it('resolves an unpinned HTML deep link while the remote registry is still pending', async () => {
    const view = mountHook(
      () => useArtifact(htmlId),
      () => new Promise<Response>(() => {}),
    )
    await settle()
    expect(view.read()).toMatchObject({ loading: false, failed: false, artifact: { id: htmlId, chatThreadId: 'chat' } })
  })

  it('keeps generated content available when the remote registry fails', async () => {
    const view = mountHook(
      () => useArtifact(htmlId),
      () => new Response('offline', { status: 503 }),
    )
    await settle()
    expect(view.read()).toMatchObject({ loading: false, failed: false, artifact: { id: htmlId } })
  })

  it('distinguishes a removed remote app from a failed registry lookup', async () => {
    const unavailable = mountHook(
      () => useArtifact(remoteId),
      () => Response.json({ apps: [] }),
    )
    await settle()
    expect(unavailable.read()).toEqual({ artifact: null, loading: false, failed: false })
    unavailable.unmount()
    resetMiniAppsForTesting()
    const failed = mountHook(
      () => useArtifact(remoteId),
      () => new Response('offline', { status: 503 }),
    )
    await settle()
    expect(failed.read()).toEqual({ artifact: null, loading: false, failed: true })
  })

  it('reports malformed and missing references as unavailable', async () => {
    const invalid = mountHook(() => useArtifact('bad:reference'))
    expect(invalid.read()).toEqual({ artifact: null, loading: false, failed: false })
    invalid.unmount()
    const missing = mountHook(() => useArtifact(artifactId({ kind: 'html', messageId: 'missing', toolCallId: 'call' })))
    await settle()
    expect(missing.read()).toEqual({ artifact: null, loading: false, failed: false })
  })

  it('reacts when the source chat is deleted rather than keeping a stale HTML copy', async () => {
    const view = mountHook(() => useArtifact(htmlId))
    await settle()
    expect(view.read().artifact?.id).toBe(htmlId)
    await getDb().update(chatThreadsTable).set({ deletedAt: '2026-01-01' }).where(eq(chatThreadsTable.id, 'chat'))
    view.triggerChange(['chat_threads'])
    await settle()
    expect(view.read()).toEqual({ artifact: null, loading: false, failed: false })
  })
})

describe('reactive artifact pins', () => {
  it('requires explicit pins for both sources and publishes pin/unpin changes to every surface', async () => {
    const view = mountHook(() => ({ pin: useArtifactPin(htmlId), pinned: usePinnedArtifacts() }))
    await settle()
    expect(view.read().pin.pinned).toBe(false)
    expect(view.read().pinned.artifacts).toEqual([])
    await act(async () => {
      await view.read().pin.setPinned(true)
    })
    view.triggerChange(['settings'])
    await settle()
    expect(view.read().pin.pinned).toBe(true)
    expect(view.read().pinned.artifacts.map(({ id }) => id)).toEqual([htmlId])
    await setArtifactPinned(getDb(), remoteId, true)
    view.triggerChange(['settings'])
    await settle()
    expect(view.read().pinned.artifacts.map(({ id }) => id)).toEqual([htmlId, remoteId])
    await act(async () => {
      await view.read().pin.setPinned(false)
    })
    view.triggerChange(['settings'])
    await settle()
    expect(view.read().pin.pinned).toBe(false)
    expect(view.read().pinned.artifacts.map(({ id }) => id)).toEqual([remoteId])
  })

  it('resolves pinned HTML offline and removes deleted content from the sidebar', async () => {
    await setArtifactPinned(getDb(), htmlId, true)
    const view = mountHook(usePinnedArtifacts, () => new Response('offline', { status: 503 }))
    await settle()
    expect(view.read()).toMatchObject({ loading: false, failed: false })
    expect(view.read().artifacts.map(({ id }) => id)).toEqual([htmlId])
    await getDb().update(chatMessagesTable).set({ deletedAt: '2026-01-01' }).where(eq(chatMessagesTable.id, 'message'))
    view.triggerChange(['chat_messages'])
    await settle()
    expect(view.read().artifacts).toEqual([])
  })

  it('surfaces a failed pin mutation and leaves the stored preference unchanged', async () => {
    const view = mountHook(() => useArtifactPin(htmlId))
    await settle()
    const failure = new Error('Write failed')
    const transaction = spyOn(getDb(), 'transaction').mockRejectedValue(failure)
    try {
      await act(async () => {
        await expect(view.read().setPinned(true)).rejects.toThrow('Write failed')
      })
      await settle()
      expect(view.read()).toMatchObject({ pinned: false, isPending: false, error: failure })
    } finally {
      transaction.mockRestore()
    }
  })
})
