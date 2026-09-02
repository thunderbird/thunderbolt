/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { AppWindow, LineChart } from 'lucide-react'

import { findMiniApp, parseMiniAppRegistry, resolveMiniAppIcon } from './registry'

const app = {
  id: 'finance-model',
  name: 'Finance Model',
  description: 'Quarterly revenue.',
  icon: 'line-chart',
  url: 'http://localhost:5174',
  origin: 'http://localhost:5174',
}

describe('parseMiniAppRegistry', () => {
  it('reads a well-formed registry', () => {
    const registry = parseMiniAppRegistry({ apps: [app] })

    expect(registry?.dropped).toBe(0)
    expect(registry?.apps).toEqual([{ ...app, icon: LineChart }])
  })

  it('reads an empty registry — this deployment runs no apps', () => {
    expect(parseMiniAppRegistry({ apps: [] })).toEqual({ apps: [], dropped: 0 })
  })

  it('fills in the optional prose fields the backend defaults', () => {
    const { description, icon: _icon, ...bare } = app

    expect(parseMiniAppRegistry({ apps: [bare] })?.apps[0]).toEqual({ ...app, description: '', icon: AppWindow })
  })

  /*
   * `origin` is what `isFromGuest` compares `event.origin` against. A cast let a
   * missing one through as `undefined`, so every message from a healthy app was
   * discarded and the panel sat at "connecting" until it gave up — with nothing
   * logged, because as far as the bridge could tell the app never spoke.
   */
  it('drops an app with no origin rather than trusting undefined', () => {
    const { origin: _origin, ...noOrigin } = app
    const registry = parseMiniAppRegistry({ apps: [app, noOrigin] })

    expect(registry?.apps.map((entry) => entry.id)).toEqual(['finance-model'])
    expect(registry?.dropped).toBe(1)
  })

  it('drops an app with no url rather than loading the string "undefined"', () => {
    const { url: _url, ...noUrl } = app

    expect(parseMiniAppRegistry({ apps: [noUrl] })).toEqual({ apps: [], dropped: 1 })
  })

  /*
   * The distinction the whole `failed` flag exists for: a body we can't read is
   * not the same as a deployment that runs no apps, and folding the two together
   * meant a broken response rendered as a serene empty sidebar.
   */
  it('reports an unreadable body as null, not as an empty registry', () => {
    expect(parseMiniAppRegistry({ nope: true })).toBeNull()
    expect(parseMiniAppRegistry([app])).toBeNull()
    expect(parseMiniAppRegistry('nope')).toBeNull()
  })
})

describe('resolveMiniAppIcon', () => {
  it('falls back to a generic window for an unknown key', () => {
    expect(resolveMiniAppIcon('no-such-icon')).toBe(AppWindow)
  })
})

describe('findMiniApp', () => {
  const apps = parseMiniAppRegistry({ apps: [app] })?.apps ?? []

  it('finds a registered app', () => {
    expect(findMiniApp(apps, 'finance-model')?.name).toBe('Finance Model')
  })

  it('is undefined for an unknown or absent id', () => {
    expect(findMiniApp(apps, 'nope')).toBeUndefined()
    expect(findMiniApp(apps, undefined)).toBeUndefined()
  })
})
