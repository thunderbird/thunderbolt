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
