/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const productLinks = {
  download: '/download/',
  web: 'https://app.thunderbolt.io/',
  github: 'https://github.com/thunderbird/thunderbolt',
  fork: 'https://github.com/thunderbird/thunderbolt/fork',
  discord: 'https://discord.gg/chwSZCBC8V',
  cliDocs: 'https://github.com/thunderbird/thunderbolt/blob/main/cli/README.md',
  privacy: '/docs/admin/security-and-privacy',
  connections: '/docs/using/connections',
  selfHost: '/docs/self-hosting',
  render: '/docs/self-hosting/public-agent',
  docker: '/docs/self-hosting/docker-compose',
  kubernetes: '/docs/self-hosting/kubernetes',
  aws: '/docs/self-hosting/pulumi',
} as const

export const cliInstallCommand =
  'curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/install.sh | sh'

export const cliPlatforms = [
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'windows', label: 'Windows' },
] as const

export type CliPlatform = (typeof cliPlatforms)[number]['id']

// Public store destinations can be filled in when the listings are available.
export const mobileStores = [
  {
    platform: 'iOS',
    store: 'App Store',
    status: 'Coming soon',
    // Official artwork: https://developer.apple.com/app-store/marketing/guidelines/
    badge: '/images/stores/app-store.svg',
    badgeWidth: 132,
  },
  {
    platform: 'Android',
    store: 'Google Play',
    status: 'Coming soon',
    // Official artwork: https://partnermarketinghub.withgoogle.com/brands/google-play/google-play/lockups-icons-badges/
    badge: '/images/stores/google-play.svg',
    badgeWidth: 149,
  },
] as const
