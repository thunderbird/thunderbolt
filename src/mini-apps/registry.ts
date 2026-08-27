/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Registry of Mini Apps — remotely-hosted surfaces embedded as first-class pages.
 *
 * Onboarding a customer app should be a config entry and nothing else. If a new
 * app ever needs a code change, the bridge protocol
 * (`shared/mini-app-protocol.ts`) is the thing to fix, not this file.
 *
 * The registry lives in backend config (`MINI_APPS`) and arrives over
 * `GET /mini-apps`, secrets stripped. It used to be a hardcoded array here,
 * which meant a per-customer build to change a hostname — and once the backend
 * needed the same list to mint identity tokens, two copies that could disagree
 * with no visible symptom beyond authentication quietly failing.
 */

import type { LucideIcon } from 'lucide-react'
import { AppWindow, BarChart3, FileSearch, LineChart, Route, Stethoscope, Table } from 'lucide-react'

export type MiniAppDefinition = {
  /** URL segment and stable key: `/apps/<id>`. */
  id: string
  /** Sidebar label and chrome title. */
  name: string
  /** One line, shown as a tooltip; also given to the model in the prompt section. */
  description: string
  icon: LucideIcon
  /** Full URL loaded into the frame. */
  url: string
  /**
   * Exact origin the frame is expected to post from, compared against
   * `event.origin`. Kept separate from `url` rather than derived: a redirect
   * could move `url` to a different origin, and the value we check against must
   * be the one an operator declared, not one the app can influence.
   */
  origin: string
}

/** The wire shape of one app from `GET /mini-apps`. */
export type MiniAppResponse = {
  id: string
  name: string
  description: string
  icon: string
  url: string
  origin: string
}

/**
 * Icon keys an operator may name in config.
 *
 * An allowlist rather than a dynamic lookup: config is operator-supplied, and
 * turning an arbitrary string into a component import is a larger surface than
 * a customer picking an icon justifies.
 */
const iconsByKey: Record<string, LucideIcon> = {
  'app-window': AppWindow,
  'bar-chart': BarChart3,
  'file-search': FileSearch,
  'line-chart': LineChart,
  route: Route,
  stethoscope: Stethoscope,
  table: Table,
}

/** Unknown or missing icon keys render as a generic window rather than nothing. */
export const resolveMiniAppIcon = (key: string): LucideIcon => iconsByKey[key] ?? AppWindow

export const toMiniAppDefinition = (app: MiniAppResponse): MiniAppDefinition => ({
  id: app.id,
  name: app.name,
  description: app.description,
  icon: resolveMiniAppIcon(app.icon),
  url: app.url,
  origin: app.origin,
})

/** Look up a registered app by its route id. */
export const findMiniApp = (apps: MiniAppDefinition[], id: string | undefined): MiniAppDefinition | undefined =>
  id === undefined ? undefined : apps.find((app) => app.id === id)
