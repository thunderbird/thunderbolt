/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { getActiveArtifactSession, useArtifactSessionStore } from './artifact-session-store'
import { chooseEmbeddedSurface } from '@/ai/embedded-surface'
import { getMiniAppSnapshot, useMiniAppStore } from '@/mini-apps/mini-app-store'
import { getArtifactContextSnapshot, useArtifactContextStore } from './artifact-context-store'
import { AppWindow } from 'lucide-react'

const app = {
  id: 'books',
  name: 'Books',
  description: '',
  url: 'https://books.test',
  origin: 'https://books.test',
  icon: AppWindow,
}
const register = (owner: string, kind: 'html' | 'remote' = 'html', inline = false) =>
  useArtifactSessionStore.getState().register({ owner, kind, inline, artifactId: owner })

// Every fixture owns its frames; clearing at both boundaries is unnecessary because
// no test here leaves its sessions registered after cleanup.
afterEach(() => {
  useArtifactSessionStore.setState({ sessions: new Map(), sequence: 0 })
  useMiniAppStore.setState({ sessions: new Map() })
  useArtifactContextStore.setState({ sessions: new Map() })
})

describe('artifact surface ownership', () => {
  it('selects the latest expanded surface even when opens share a clock tick', () => {
    register('remote', 'remote')
    register('html')
    expect(getActiveArtifactSession()?.owner).toBe('html')
    expect(chooseEmbeddedSurface(getActiveArtifactSession())).toBe('artifact')
  })

  it('does not let inline mounts steal an expanded surface', () => {
    register('remote', 'remote')
    register('inline-a', 'html', true)
    register('inline-b', 'html', true)
    expect(getActiveArtifactSession()?.owner).toBe('remote')
  })

  it('activates inline content on explicit interaction and restores the previous surface on close', () => {
    register('remote', 'remote')
    register('inline', 'html', true)
    useArtifactSessionStore.getState().activate('inline')
    expect(getActiveArtifactSession()?.owner).toBe('inline')
    useArtifactSessionStore.getState().unregister('inline')
    expect(getActiveArtifactSession()?.owner).toBe('remote')
  })

  it('falls back to mounted inline content when the expanded surface closes', () => {
    register('inline-a', 'html', true)
    register('expanded')
    register('inline-b', 'html', true)
    useArtifactSessionStore.getState().unregister('expanded')
    expect(getActiveArtifactSession()?.owner).toBe('inline-b')
  })

  it('ignores a stale cleanup or focus callback after replacement', () => {
    register('old')
    register('new')
    useArtifactSessionStore.getState().unregister('old')
    useArtifactSessionStore.getState().activate('old')
    useArtifactSessionStore.getState().unregister('old')
    expect(getActiveArtifactSession()?.owner).toBe('new')
  })

  it('has no active context after all owners close', () => {
    register('only')
    useArtifactSessionStore.getState().unregister('only')
    expect(getActiveArtifactSession()).toBeNull()
  })

  it('keeps two HTML contexts separate and ignores late reports from a closed owner', () => {
    const store = useArtifactContextStore.getState()
    store.openArtifact('First', 'first')
    store.openArtifact('Second', 'second')
    store.setContext({ title: 'First', summary: 'A' }, 'first')
    store.setContext({ title: 'Second', summary: 'B' }, 'second')
    store.closeArtifact('first')
    store.setContext({ title: 'Stale', summary: 'Old' }, 'first')
    expect(getArtifactContextSnapshot('first').title).toBeNull()
    expect(getArtifactContextSnapshot('second').context?.summary).toBe('B')
  })

  it('keeps two remote frames separate through tool discovery, reset and close', () => {
    const store = useMiniAppStore.getState()
    const invoke = async () => ({ content: 'result' })
    store.openApp(app, 'first')
    store.openApp(app, 'second')
    store.setTools([{ name: 'first_tool', description: '' }], invoke, 'first')
    store.setTools([{ name: 'second_tool', description: '' }], invoke, 'second')
    store.setContextReader(async () => ({ title: 'Second', summary: 'Current' }), 'second')
    store.resetGuest('first')
    expect(getMiniAppSnapshot('first').tools).toEqual([])
    expect(getMiniAppSnapshot('second').tools[0]?.name).toBe('second_tool')
    store.closeApp('first')
    store.setTools([{ name: 'stale', description: '' }], invoke, 'first')
    expect(getMiniAppSnapshot('first').app).toBeNull()
    expect(getMiniAppSnapshot('second').requestContext).not.toBeNull()
  })
})
