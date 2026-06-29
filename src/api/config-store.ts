/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppConfig = {
  /** Stable per-deployment UUID. Returned by `GET /v1/config`; required in
   *  server trust domains (the FE uses it to namespace auth token / device ID /
   *  encryption keys / DB filename). Optional on this type because an offline
   *  boot may have no cached config yet — boot code MUST treat its absence as
   *  "no server reachable", never as "any server is fine". */
  serverId?: string
  e2eeEnabled?: boolean
  /** Server-side anonymous-sessions flag. When false, the BE rejects
   *  `/sign-in/anonymous`. Mirrors the BE `AUTH_ALLOW_ANONYMOUS`. */
  allowAnonUsers?: boolean
  /** Workspace creation policy. Enforced by the BE upload-handler factory; UI
   *  hides the "Create workspace" affordance when both gates evaluate to false
   *  for the active user. */
  allowWorkspaceCreationByAnon?: boolean
  allowWorkspaceCreationByMembers?: boolean
  /** Deployment-level UI capability flags from `GET /config`. Optional so an
   *  empty/offline config (standalone mode) reads as "default behavior":
   *  built-in agent shown, custom agents allowed. */
  builtInAgentEnabled?: boolean
  allowCustomAgents?: boolean
  /** Minimum semver string the server allows. Clients below this are hard-blocked
   *  until they upgrade. Absent/empty = no enforcement. */
  minAppVersion?: string
  /** Per-row scope on the 8 workspace-shared resource tables (THU-603). When
   *  false the UI hides the scope picker and the BE upload handler rejects
   *  `scope = 'user'` PUTs. Absent (offline/standalone) reads as allowed —
   *  same opt-out posture as the server-side default. */
  allowUserScopedResources?: boolean
}

type ConfigStore = {
  config: AppConfig
  updateConfig: (config: AppConfig) => void
}

const initialState = { config: {} as AppConfig }

export const useConfigStore = create<ConfigStore>()(
  persist(
    (set) => ({
      ...initialState,
      updateConfig: (config) => set({ config }),
    }),
    { name: 'thunderbolt-config' },
  ),
)

/** Whether the built-in Thunderbolt agent appears in the agent list. Absent
 *  config (offline/standalone) defaults to enabled, so the app always has at
 *  least the built-in to fall back on. */
export const selectBuiltInAgentEnabled = (config: AppConfig): boolean => config.builtInAgentEnabled !== false

/** Whether the UI offers adding custom agents. Absent config defaults to allowed. */
export const selectAllowCustomAgents = (config: AppConfig): boolean => config.allowCustomAgents !== false

/** Whether the UI offers per-row scope (workspace vs private) on the 8 shared
 *  resource tables. Absent config defaults to allowed, mirroring the BE default. */
export const selectAllowUserScopedResources = (config: AppConfig): boolean => config.allowUserScopedResources !== false
