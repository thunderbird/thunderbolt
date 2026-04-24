/**
 * Complete default mock for `@/lib/platform`.
 *
 * bun's `mock.module` replaces the entire module, so partial mocks
 * (e.g. only `isTauri` + `getPlatform`) leave other exports undefined
 * and poison the module cache for any test that runs afterward.
 *
 * Usage:
 *   import { webPlatformMock } from '@/test-utils/platform-mock'
 *   mock.module('@/lib/platform', () => ({ ...webPlatformMock, isTauri: () => true }))
 */

const prPreviewRegex = /^thunderbolt-pr-\d+\.onrender\.com$/

export const webPlatformMock = {
  prPreviewHostRegex: prPreviewRegex,
  isPrPreview: () => {
    if (typeof window === 'undefined') {
      return false
    }
    return prPreviewRegex.test(window.location.hostname)
  },
  isTauri: () => false,
  getPlatform: () => 'web' as const,
  isDesktop: () => false,
  isMobile: () => false,
  getWebOsPlatform: () => 'unknown' as const,
  isWebMobilePlatform: () => false,
  isWebDesktopPlatform: () => false,
  isAgentAvailableOnPlatform: (type: string) => type !== 'local',
  getWebBrowser: () => 'unknown' as const,
  isOpfsAvailable: async () => true,
  getCapabilities: async () => ({ libsql: false, native_fetch: false }),
  getDatabaseType: async () => 'powersync' as const,
  getDatabasePath: async (_dbType: string, appDataDir: string) => `${appDataDir}/thunderbolt-sync.db`,
  getDeviceDisplayName: () => 'Browser on Unknown',
}

export const desktopPlatformMock = {
  ...webPlatformMock,
  isTauri: () => true,
  getPlatform: () => 'macos' as const,
  isDesktop: () => true,
  getDeviceDisplayName: () => 'Thunderbolt on macOS',
}
