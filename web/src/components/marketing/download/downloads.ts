/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const releasesUrl = 'https://github.com/thunderbird/thunderbolt/releases/latest'
export const releaseApiUrl = '/downloads/release.json'

export const desktopPlatforms = [
  { id: 'macos', name: 'macOS' },
  { id: 'windows', name: 'Windows' },
  { id: 'linux', name: 'Linux' },
] as const
export type DesktopPlatform = (typeof desktopPlatforms)[number]['id']
export type DetectedPlatform = DesktopPlatform | 'ios' | 'android' | 'unknown'

export const installers = [
  {
    id: 'mac-arm',
    platform: 'macos',
    label: 'Apple Silicon',
    format: '.dmg',
    pattern: /^Thunderbolt_[\d.]+_aarch64\.dmg$/,
  },
  { id: 'mac-intel', platform: 'macos', label: 'Intel', format: '.dmg', pattern: /^Thunderbolt_[\d.]+_x64\.dmg$/ },
  {
    id: 'windows-x64',
    platform: 'windows',
    label: 'Intel / AMD (x64)',
    format: '.exe',
    pattern: /^Thunderbolt_[\d.]+_x64-setup\.exe$/,
  },
  {
    id: 'windows-arm',
    platform: 'windows',
    label: 'ARM64',
    format: '.exe',
    pattern: /^Thunderbolt_[\d.]+_arm64-setup\.exe$/,
  },
  {
    id: 'linux-appimage',
    platform: 'linux',
    label: 'AppImage',
    format: 'x64',
    pattern: /^Thunderbolt_[\d.]+_amd64\.AppImage$/,
  },
  {
    id: 'linux-deb',
    platform: 'linux',
    label: 'Debian / Ubuntu',
    format: '.deb · x64',
    pattern: /^Thunderbolt_[\d.]+_amd64\.deb$/,
  },
  {
    id: 'linux-rpm',
    platform: 'linux',
    label: 'Fedora / RPM',
    format: '.rpm · x64',
    pattern: /^Thunderbolt-[\d.]+-\d+\.x86_64\.rpm$/,
  },
] as const
export type InstallerId = (typeof installers)[number]['id']
export type DownloadRelease = { version: string; downloads: Partial<Record<InstallerId, string>> }

/** Detect the OS only. Browser user agents cannot reliably identify a Mac's chip. */
export const detectPlatform = (userAgent: string, maxTouchPoints = 0): DetectedPlatform => {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
  if (/CrOS/i.test(userAgent)) return 'unknown'
  if (/Linux/i.test(userAgent)) return 'linux'
  return 'unknown'
}

/** Read only uploaded desktop installers; construct URLs on the official release host. */
export const parseRelease = (value: unknown): DownloadRelease => {
  if (
    !value ||
    typeof value !== 'object' ||
    !('tag_name' in value) ||
    typeof value.tag_name !== 'string' ||
    !value.tag_name ||
    !('assets' in value) ||
    !Array.isArray(value.assets) ||
    !('draft' in value) ||
    value.draft !== false ||
    !('prerelease' in value) ||
    value.prerelease !== false
  ) {
    throw new Error('Invalid stable release')
  }
  const downloads: DownloadRelease['downloads'] = {}
  for (const asset of value.assets) {
    if (
      !asset ||
      typeof asset !== 'object' ||
      !('name' in asset) ||
      typeof asset.name !== 'string' ||
      !('state' in asset) ||
      asset.state !== 'uploaded'
    )
      continue
    const installer = installers.find((item) => item.pattern.test(asset.name))
    if (installer) {
      downloads[installer.id] =
        `https://github.com/thunderbird/thunderbolt/releases/download/${encodeURIComponent(value.tag_name)}/${encodeURIComponent(asset.name)}`
    }
  }
  return { version: value.tag_name, downloads }
}

/** Read release metadata from the website’s shared cache, never GitHub from the browser. */
export const loadRelease = async (signal: AbortSignal): Promise<DownloadRelease> => {
  const response = await fetch(releaseApiUrl, { signal, headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`Release lookup failed: ${response.status}`)
  return parseRelease(await response.json())
}
