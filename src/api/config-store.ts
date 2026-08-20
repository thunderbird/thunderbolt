/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SharedModel } from '@shared/defaults/models'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppConfig = {
  e2eeEnabled?: boolean
  /** Deployment-level UI capability flags from `GET /config`. Optional so an
   *  empty/offline config (standalone mode) reads as "default behavior":
   *  built-in agent shown, custom agents allowed. */
  builtInAgentEnabled?: boolean
  allowCustomAgents?: boolean
  /** Minimum semver string the server allows. Clients below this are hard-blocked
   *  until they upgrade. Absent/empty = no enforcement. */
  minAppVersion?: string
  /** Server-shipped default sets, versioned so the client can pick between
   *  server and bundled by whichever declares the higher version. See
   *  "Reconciled defaults and version bumps" in AGENTS.md. */
  defaults?: {
    models?: {
      version: number
      data: SharedModel[]
    }
  }
}

type ConfigStore = {
  config: AppConfig
  updateConfig: (config: AppConfig) => void
  /** Transient (never persisted): set when the backend hard-rejects this build
   *  with HTTP 426. Flips the app into the upgrade blocker for the current
   *  session only — a reload re-derives the gate from `config.minAppVersion`. */
  forceUpgrade?: boolean
  /** Server-advertised minimum version carried by the 426 response, shown in the
   *  upgrade blocker. Optional — the response may omit it. */
  forceUpgradeMinVersion?: string
  setForceUpgrade: (minVersion?: string) => void
}

const initialState = { config: {} as AppConfig }

export const useConfigStore = create<ConfigStore>()(
  persist(
    (set) => ({
      ...initialState,
      updateConfig: (config) => set({ config }),
      setForceUpgrade: (minVersion) => set({ forceUpgrade: true, forceUpgradeMinVersion: minVersion }),
    }),
    // Persist only `config` — the transient upgrade flag must not survive a
    // reload (the reload itself is the upgrade path once the build is updated).
    { name: 'thunderbolt-config', partialize: (state) => ({ config: state.config }) },
  ),
)

/** Whether the built-in Thunderbolt agent appears in the agent list. Absent
 *  config (offline/standalone) defaults to enabled, so the app always has at
 *  least the built-in to fall back on. */
export const selectBuiltInAgentEnabled = (config: AppConfig): boolean => config.builtInAgentEnabled !== false

/** Whether the UI offers adding custom agents. Absent config defaults to allowed. */
export const selectAllowCustomAgents = (config: AppConfig): boolean => config.allowCustomAgents !== false
