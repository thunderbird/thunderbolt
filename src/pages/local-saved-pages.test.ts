/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, expect, it } from 'bun:test'
import { createLocalSavedPagesStore } from './local-saved-pages'
import { createSavedPage, localSavedPageKeyPrefix } from './saved-page'

beforeEach(() => localStorage.clear())

it('restores valid local shortcuts independently and keeps snapshots referentially stable', () => {
  const page = createSavedPage({ id: 'local', title: 'App', source: { kind: 'local-app', appId: 'app' } }, 'app')
  const store = createLocalSavedPagesStore()
  let notifications = 0
  const unsubscribe = store.subscribe(() => notifications++)
  store.save(page)
  localStorage.setItem(`${localSavedPageKeyPrefix}broken`, '{bad')
  const restored = createLocalSavedPagesStore()
  expect(restored.getSnapshot()).toEqual([page])
  expect(restored.getSnapshot()).toBe(restored.getSnapshot())
  expect(notifications).toBe(1)
  unsubscribe()
})

it('never accepts a website into the local app registry and surfaces storage write failures', () => {
  const website = createSavedPage(
    { id: 'website', title: 'Website', source: { kind: 'url', url: 'https://example.com' } },
    'browser',
  )
  expect(() => createLocalSavedPagesStore().save(website)).toThrow('Only local app pages')
  const page = createSavedPage({ id: 'local', title: 'App', source: { kind: 'local-app', appId: 'app' } }, 'app')
  const failing = createLocalSavedPagesStore(() => ({
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {
      throw new Error('Storage full')
    },
  }))
  expect(() => failing.save(page)).toThrow('Storage full')
})

it('forgets local shortcuts after identity cleanup clears storage', () => {
  const store = createLocalSavedPagesStore()
  store.save(createSavedPage({ id: 'local', title: 'App', source: { kind: 'local-app', appId: 'app' } }, 'app'))
  expect(store.getSnapshot()).toHaveLength(1)
  localStorage.clear()
  store.refresh()
  expect(store.getSnapshot()).toEqual([])
})
