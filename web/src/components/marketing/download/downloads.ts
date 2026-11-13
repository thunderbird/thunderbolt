/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { productLinks } from '../../../data/website-product'

/** GitHub's page for the latest release, for visitors no direct installer link fits. */
export const latestReleasePage = `${productLinks.github}/releases/latest`

/**
 * The desktop platforms and the installers each release ships for them. A platform's first
 * installer is the one recommended to its visitors: a browser reveals the operating system
 * but not reliably the chip.
 */
export const desktopPlatforms = [
  {
    id: 'macos',
    name: 'macOS',
    installers: [
      { id: 'mac-arm', label: 'Apple Silicon', format: '.dmg', pattern: /^Thunderbolt_[\d.]+_aarch64\.dmg$/ },
      { id: 'mac-intel', label: 'Intel', format: '.dmg', pattern: /^Thunderbolt_[\d.]+_x64\.dmg$/ },
    ],
  },
  {
    id: 'windows',
    name: 'Windows',
    installers: [
      {
        id: 'windows-x64',
        label: 'Intel / AMD (x64)',
        format: '.exe',
        pattern: /^Thunderbolt_[\d.]+_x64-setup\.exe$/,
      },
      { id: 'windows-arm', label: 'ARM64', format: '.exe', pattern: /^Thunderbolt_[\d.]+_arm64-setup\.exe$/ },
    ],
  },
  {
    id: 'linux',
    name: 'Linux',
    installers: [
      { id: 'linux-appimage', label: 'AppImage', format: 'x64', pattern: /^Thunderbolt_[\d.]+_amd64\.AppImage$/ },
      {
        id: 'linux-deb',
        label: 'Debian / Ubuntu',
        format: '.deb · x64',
        pattern: /^Thunderbolt_[\d.]+_amd64\.deb$/,
      },
      {
        id: 'linux-rpm',
        label: 'Fedora / RPM',
        format: '.rpm · x64',
        pattern: /^Thunderbolt-[\d.]+-\d+\.x86_64\.rpm$/,
      },
    ],
  },
] as const

type Installer = (typeof desktopPlatforms)[number]['installers'][number]
export const installers = desktopPlatforms.flatMap<Installer>((platform) => platform.installers)
export type InstallerId = Installer['id']
export type DetectedPlatform = (typeof desktopPlatforms)[number]['id'] | 'ios' | 'android' | 'unknown'

/** A release's version, and a direct link for each installer it has. */
export type DownloadRelease = { version: string; downloads: Partial<Record<InstallerId, string>> }

/** Tell the visitor's operating system from the browser's user agent and touch support. */
export const detectPlatform = (userAgent: string, maxTouchPoints: number): DetectedPlatform => {
  // iPadOS presents itself as a Mac; only its touch screen tells the two apart.
  if (/iPhone|iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Macintosh/i.test(userAgent)) return 'macos'
  if (/Linux/i.test(userAgent)) return 'linux'
  return 'unknown'
}

/** The fields this site reads from GitHub's description of a release. */
type GitHubRelease = { tag_name: string; assets: { name: string; state: string }[] }

const isGitHubRelease = (value: unknown): value is GitHubRelease =>
  typeof value === 'object' &&
  value !== null &&
  'tag_name' in value &&
  typeof value.tag_name === 'string' &&
  'assets' in value &&
  Array.isArray(value.assets)

/**
 * Read a release from GitHub's description of it. Only uploaded assets whose names are those
 * of known installers become downloads, and their links are built here, on the official
 * repository, rather than taken from the description.
 */
export const parseRelease = (value: unknown): DownloadRelease => {
  if (!isGitHubRelease(value)) throw new Error('Invalid release')
  const downloads: DownloadRelease['downloads'] = {}
  for (const asset of value.assets) {
    const installer = installers.find((item) => item.pattern.test(asset.name))
    if (installer && asset.state === 'uploaded') {
      // The tag is the one part of the link that is not checked against a pattern.
      downloads[installer.id] =
        `${productLinks.github}/releases/download/${encodeURIComponent(value.tag_name)}/${asset.name}`
    }
  }
  return { version: value.tag_name, downloads }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Load the latest release from the website's own copy of GitHub's answer. Browsers never ask
 * GitHub: the copy is cached for every visitor, and falls back to the release the site was
 * built with.
 */
export const loadRelease = async (signal: AbortSignal, request: Fetch = fetch): Promise<DownloadRelease> => {
  const response = await request('/downloads/release.json', { signal })
  if (!response.ok) throw new Error(`Release lookup failed: ${response.status}`)
  return parseRelease(await response.json())
}
