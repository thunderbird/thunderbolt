/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type { Arch, Platform } from '@tauri-apps/plugin-os'

import { isRecord } from '@/lib/utils'

export type CliInstallPlatform = Platform | 'web'
export type CliInstallArchitecture = Arch | 'unknown'

/** A successful one-click install of the `thunderbolt` CLI, mirroring the Rust
 *  `CliInstallResult` (serialized camelCase). */
export type CliInstallResult = {
  /** Absolute path the binary was installed to (`~/.local/bin/thunderbolt`). */
  path: string
  /** Whether `~/.local/bin` is already on the user's `PATH`. */
  onPath: boolean
  /** Shell line to add the install dir to `PATH`; present only when `onPath` is false. */
  pathHint: string | null
}

/** The typed failure kinds the Rust `install_thunderbolt_cli` command returns. */
export type CliInstallErrorKind = 'unsupported' | 'notPublished' | 'download' | 'checksumMismatch' | 'install'

/** A typed install failure, mirroring the Rust `CliInstallError` (`{ kind, message }`). */
export type CliInstallError = {
  kind: CliInstallErrorKind
  message: string
}

const cliInstallErrorKinds: ReadonlyArray<CliInstallErrorKind> = [
  'unsupported',
  'notPublished',
  'download',
  'checksumMismatch',
  'install',
]

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

/**
 * Invokes the Rust command that downloads, checksum-verifies and installs the
 * prebuilt `thunderbolt` CLI into `~/.local/bin`. Resolves with the install
 * result or rejects with a {@link CliInstallError}.
 *
 * @param invoke - Injectable Tauri `invoke` (production omits; tests supply a fake).
 */
export const installThunderboltCli = (invoke: InvokeFn = tauriInvoke): Promise<CliInstallResult> =>
  invoke<CliInstallResult>('install_thunderbolt_cli')

/**
 * Whether the CLI release pipeline publishes a prebuilt binary for this
 * OS/architecture pair. Mirrors Rust `resolve_target`. Callers gate on the
 * Tauri runtime separately — this is a pure target lookup.
 */
export const canInstallThunderboltCli = (platform: CliInstallPlatform, architecture: CliInstallArchitecture): boolean =>
  (platform === 'macos' && architecture === 'aarch64') ||
  (platform === 'linux' && (architecture === 'x86_64' || architecture === 'aarch64'))

/** Narrows an unknown rejection value to a typed {@link CliInstallError}. */
export const isCliInstallError = (value: unknown): value is CliInstallError =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  cliInstallErrorKinds.includes(value.kind as CliInstallErrorKind) &&
  typeof value.message === 'string'

/** UI-ready view of a failed install. */
export type CliInstallErrorView = {
  message: string
  /** Whether to offer the manual "build from source" fallback — only when there
   *  is genuinely no prebuilt binary to install (unsupported platform or a
   *  release that predates the CLI pipeline). */
  showManualBuild: boolean
}

/**
 * Maps any install rejection to a message plus whether to surface the manual
 * build fallback. `unsupported` and `notPublished` mean no binary exists to
 * download, so the honest next step is building from source; every other kind is
 * a transient/operational failure the user can retry.
 */
export const describeCliInstallError = (error: unknown): CliInstallErrorView => {
  if (isCliInstallError(error)) {
    return {
      message: error.message,
      showManualBuild: error.kind === 'unsupported' || error.kind === 'notPublished',
    }
  }
  return { message: String(error), showManualBuild: false }
}
