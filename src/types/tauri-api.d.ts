/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ambient module declarations to silence "Cannot find module" errors when
// the type definitions are missing. Remove this file once @tauri-apps/api
// and @tauri-apps/plugin-os ship their own typings compatible with our
// current TypeScript setup.

// ---------------------------------------------------------------------------
// @tauri-apps/api/core
// ---------------------------------------------------------------------------
declare module '@tauri-apps/api/core' {
  // Minimal surface we actually use. Extend as needed.
  export function isTauri(): boolean
  export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

// ---------------------------------------------------------------------------
// @tauri-apps/plugin-os
// ---------------------------------------------------------------------------
declare module '@tauri-apps/plugin-os' {
  export type Platform =
    | 'linux'
    | 'macos'
    | 'ios'
    | 'android'
    | 'windows'
    | 'freebsd'
    | 'dragonfly'
    | 'netbsd'
    | 'openbsd'
    | 'solaris'

  export function platform(): Platform
}
