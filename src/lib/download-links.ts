import { getWebOsPlatform } from '@/lib/platform'

export const downloadLinks = {
  macos:
    'https://github.com/thunderbird/thunderbolt/releases/download/untagged-2336dbd4acc33a514985/Thunderbolt_0.1.61_aarch64.dmg',
  windows:
    'https://github.com/thunderbird/thunderbolt/releases/download/untagged-2336dbd4acc33a514985/Thunderbolt_0.1.61_arm64-setup.exe',
  linux:
    'https://github.com/thunderbird/thunderbolt/releases/download/untagged-2336dbd4acc33a514985/Thunderbolt_0.1.61_amd64.AppImage',
  ios: 'https://apps.apple.com/app/thunderbolt',
  android: 'https://play.google.com/store/apps/details?id=net.thunderbird.thunderbolt',
} as const

/**
 * Returns the download URL for the current platform, falling back to macOS
 * when the platform is unknown or not in the links map.
 */
export const getDownloadUrl = (): string => {
  const platform = getWebOsPlatform()
  if (platform !== 'unknown' && platform in downloadLinks) {
    return downloadLinks[platform]
  }
  return downloadLinks.macos
}
