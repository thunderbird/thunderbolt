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
import { z } from 'zod'

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

/**
 * The wire shape of one app from `GET /mini-apps`.
 *
 * Parsed, not asserted with a generic on `.json()`. A cast here fails in the
 * worst possible way, because `origin` is the value `isFromGuest` compares
 * `event.origin` against: if a deploy skew ever renamed or dropped it, the
 * comparison becomes `event.origin === undefined`, every message from a
 * perfectly healthy app is discarded, and the panel sits at "connecting" until
 * it gives up — with nothing logged, because from the bridge's point of view
 * the app never spoke. `url` missing is milder and just as opaque: the frame
 * loads the literal string "undefined".
 */
export const miniAppResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  icon: z.string().default(''),
  url: z.string().min(1),
  origin: z.string().min(1),
})

export type MiniAppResponse = z.infer<typeof miniAppResponseSchema>

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

/**
 * Turn a `GET /mini-apps` body into definitions, dropping only bad entries.
 *
 * `null` means the body itself was unusable — a real failure, distinct from a
 * deployment that runs no apps, and the two must not collapse into each other
 * (see {@link MiniAppsState.failed}). Individual entries are parsed one at a
 * time, mirroring `getMiniApps` on the backend: one malformed app should cost
 * that app, not the sidebar.
 */
export const parseMiniAppRegistry = (body: unknown): { apps: MiniAppDefinition[]; dropped: number } | null => {
  const envelope = z.object({ apps: z.array(z.unknown()) }).safeParse(body)
  if (!envelope.success) {
    return null
  }

  const apps: MiniAppDefinition[] = []
  let dropped = 0
  for (const candidate of envelope.data.apps) {
    const parsed = miniAppResponseSchema.safeParse(candidate)
    if (parsed.success) {
      apps.push(toMiniAppDefinition(parsed.data))
      continue
    }
    dropped += 1
  }
  return { apps, dropped }
}

/** Look up a registered app by its route id. */
export const findMiniApp = (apps: MiniAppDefinition[], id: string | undefined): MiniAppDefinition | undefined =>
  id === undefined ? undefined : apps.find((app) => app.id === id)
