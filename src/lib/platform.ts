import { platform } from '@tauri-apps/plugin-os'

/**
 * Get the current platform
 * @returns The platform string: 'linux', 'macos', 'ios', 'android', 'windows', etc.
 */
export const getPlatform = (): string => {
  return platform()
}

/**
 * Detects if the app is running on iOS
 * @returns true if running on iOS, false otherwise
 */
export const isIOS = (): boolean => {
  return platform() === 'ios'
}

/**
 * Detects if the app is running on a desktop platform
 * @returns true if running on desktop (macOS, Windows, Linux), false otherwise
 */
export const isDesktop = (): boolean => {
  const currentPlatform = platform()
  return ['linux', 'macos', 'windows', 'freebsd', 'dragonfly', 'netbsd', 'openbsd', 'solaris'].includes(currentPlatform)
}

/**
 * Detects if the app is running on Android
 * @returns true if running on Android, false otherwise
 */
export const isAndroid = (): boolean => {
  return platform() === 'android'
}

/**
 * Detects if the app is running on a mobile platform
 * @returns true if running on mobile (iOS or Android), false otherwise
 */
export const isMobile = (): boolean => {
  const currentPlatform = platform()
  return currentPlatform === 'ios' || currentPlatform === 'android'
}