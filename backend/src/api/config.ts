/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { Elysia } from 'elysia'

/**
 * Public app config — the single source of deployment-level UI capability flags
 * (no auth, fetched at boot). The frontend mirrors this into its config store and
 * falls back to the cached value when offline (standalone mode keeps working).
 *
 * `defaults` ships the reconciled default sets (models today, more to follow) as
 * an OTA channel: clients pick between the server payload and their bundled copy
 * by comparing versions, so shipped defaults changes don't require a client
 * release. See "Reconciled defaults and version bumps" in AGENTS.md.
 */
export const createConfigRoutes = (settings: Settings) =>
  new Elysia({ prefix: '/config' }).onError(safeErrorHandler).get('/', () => ({
    e2eeEnabled: settings.e2eeEnabled,
    // Inverted so the env reads as an opt-in switch ("disable") while the wire
    // contract reads as a positive capability ("enabled").
    builtInAgentEnabled: !settings.disableBuiltInAgent,
    allowCustomAgents: settings.allowCustomAgents,
    // Omit when unset so the frontend treats it as "no enforcement" without parsing an empty string as semver.
    minAppVersion: settings.minAppVersion || undefined,
    defaults: {
      models: {
        version: defaultModelsVersion,
        data: defaultModels,
      },
    },
  }))
