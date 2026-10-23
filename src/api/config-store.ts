/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SharedModel } from '@shared/defaults/models'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppConfig = {
  /**
   * Whether the deployment escrows every AK to an operator-held key (THU-804).
   * Surfaced for the deferred end-user disclosure UI; nothing reads it yet, and
   * the wrap path must never branch on it — escrow is driven solely by the
   * build-time pin (`pinnedOrgEscrowPublicKey`), since any server-supplied flag
   * or key can be a lie (THU-866, C11).
   */
  orgEscrowEnabled?: boolean
  /** Deployment-level UI capability flags from `GET /config`. Optional so an
   *  empty/offline config (standalone mode) reads as "default behavior":
   *  built-in agent shown, custom agents allowed. */
  builtInAgentEnabled?: boolean
  allowCustomAgents?: boolean
  /** Chat-only shell for public deployments; see `selectMinimalMode`. */
  minimalMode?: boolean
  /** Operator logo for the minimal-mode header; see `selectBrandLogo`. */
  brandLogoUrl?: string
  brandLogoDarkUrl?: string
  brandLogoAlt?: string
  /** Operator branding (`PublicBranding`), exactly as received. Read it only
   *  through `selectBranding` (`src/lib/branding-selectors.ts`), which validates
   *  it before it becomes CSS, hrefs or request paths. */
  branding?: unknown
  debugTranscriptsEnabled?: boolean
  /** Whether the deployment offers passkeys (sign-in and sync unlock). False or
   *  absent (an older backend) = off; the frontend hides all passkey UI. */
  passkeyEnabled?: boolean
  /** The WebAuthn RP ID passkeys are registered under. Absent = the page's hostname. */
  passkeyRpId?: string
  /** Minimum semver string the server allows. Clients below this are hard-blocked
   *  until they upgrade. Absent/empty = no enforcement. */
  minAppVersion?: string
  /** Server-shipped default sets, versioned so the client can pick between
   *  server and bundled by whichever declares the higher version. See
   *  "Reconciled defaults and version bumps" in AGENTS.md. */
  defaults?: {
    models?: {
      version: number
      defaultModelId: string
      data: SharedModel[]
    }
  }
}

type ConfigStore = {
  config: AppConfig
  /** Transient (never persisted): true once `/config` has answered this session.
   *  Until then `config` is `{}` or last session's cache. Gates read it through
   *  `selectConfigSettled`, which also accepts a non-empty cache. */
  configLoaded: boolean
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

const initialState = { config: {} as AppConfig, configLoaded: false }

export const useConfigStore = create<ConfigStore>()(
  persist(
    (set) => ({
      ...initialState,
      updateConfig: (config) => set({ config, configLoaded: true }),
      setForceUpgrade: (minVersion) => set({ forceUpgrade: true, forceUpgradeMinVersion: minVersion }),
    }),
    // Persist only `config` — the transient upgrade flag must not survive a
    // reload (the reload itself is the upgrade path once the build is updated).
    // index.html's pre-paint script reads this key (src/prepaint.test.ts).
    { name: 'thunderbolt-config', partialize: (state) => ({ config: state.config }) },
  ),
)

/** Whether the UI can render deployment-gated controls (Settings toggle, skill
 *  chips, Projects, account control) without risk of flashing them in and out.
 *  A persisted config is good enough to render from immediately, since the gates
 *  read `minimalMode` from that same value; only a first-ever visit, with
 *  nothing persisted, waits for the `/config` fetch, bounded by its timeout. */
export const selectConfigSettled = (state: Pick<ConfigStore, 'config' | 'configLoaded'>): boolean =>
  state.configLoaded || Object.keys(state.config).length > 0

/** Whether the built-in Thunderbolt agent appears in the agent list. Absent
 *  config (offline/standalone) defaults to enabled, so the app always has at
 *  least the built-in to fall back on. */
export const selectBuiltInAgentEnabled = (config: AppConfig): boolean => config.builtInAgentEnabled !== false

/** Whether the deployment runs in minimal mode (`MINIMAL_MODE=true`): the
 *  chat-only shell for public deployments. It hides Settings and its routes, the
 *  starter skill chips, Projects, the account/cloud control, the header's agent pill and
 *  the Settings destinations in the palette and search. Slash commands are off too:
 *  `/` is plain text, and no skill is offered to any agent. Absent means off. Role-based visibility is
 *  expected to replace this predicate. */
export const selectMinimalMode = (config: AppConfig): boolean => config.minimalMode === true

/** The operator's header logo, or null when `BRAND_LOGO_URL` is unset. Dark
 *  falls back to the light URL; `alt` is empty when unset, so the caller picks
 *  its own fallback. */
export const selectBrandLogo = (config: AppConfig): { light: string; dark: string; alt: string } | null => {
  if (!config.brandLogoUrl) {
    return null
  }
  return {
    light: config.brandLogoUrl,
    dark: config.brandLogoDarkUrl || config.brandLogoUrl,
    alt: config.brandLogoAlt ?? '',
  }
}

/** Whether the UI offers adding custom agents. Absent config defaults to allowed. */
export const selectAllowCustomAgents = (config: AppConfig): boolean => config.allowCustomAgents !== false

/** Whether the server explicitly accepts debug transcript uploads. Absent
 * config is disabled because standalone mode has no backend recipient. */
export const selectDebugTranscriptsEnabled = (config: AppConfig): boolean => config.debugTranscriptsEnabled === true

/** Whether the deployment offers passkeys (sign-in and sync unlock). Absent config (offline/
 * standalone) is disabled — passkeys need the backend plugin to be registered. */
export const selectPasskeyEnabled = (config: AppConfig): boolean => config.passkeyEnabled === true
