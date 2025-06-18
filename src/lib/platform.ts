import { isTauri as isTauriCore } from '@tauri-apps/api/core'
import { platform, type Platform } from '@tauri-apps/plugin-os'

/**
 * Detects if the app is running in a Tauri environment
 * @returns true if running in Tauri, false otherwise
 */
export const isTauri = (): boolean => {
  return 'isTauri' in window && isTauriCore()
}

/**
 * Get the current platform
 * @returns The platform string: 'linux', 'macos', 'ios', 'android', 'windows', etc.
 */
export const getPlatform = (): 'web' | Platform => {
  return 'isTauri' in window ? platform() : 'web'
}

/**
 * Detects if the app is running on a desktop platform
 * @returns true if running on desktop (macOS, Windows, Linux), false otherwise
 */
export const isDesktop = (): boolean => {
  const currentPlatform = getPlatform()
  return ['linux', 'macos', 'windows', 'freebsd', 'dragonfly', 'netbsd', 'openbsd', 'solaris'].includes(currentPlatform)
}

/**
 * Detects if the app is running on a mobile platform
 * @returns true if running on mobile (iOS or Android), false otherwise
 */
export const isMobile = (): boolean => {
  const currentPlatform = getPlatform()
  return currentPlatform === 'ios' || currentPlatform === 'android'
}
