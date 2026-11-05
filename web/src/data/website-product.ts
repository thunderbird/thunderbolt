/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const productLinks = {
  download: 'https://github.com/thunderbird/thunderbolt/releases/latest',
  web: 'https://app.thunderbolt.io/',
  github: 'https://github.com/thunderbird/thunderbolt',
  fork: 'https://github.com/thunderbird/thunderbolt/fork',
  discord: 'https://discord.gg/chwSZCBC8V',
  enterprise: '/contact',
  cliDocs: 'https://github.com/thunderbird/thunderbolt/blob/main/cli/README.md',
  privacy: '/docs/admin/security-and-privacy',
  connections: '/docs/using/connections',
  platforms: '/docs/using/apps-and-sync',
  selfHost: '/docs/self-hosting',
  render: '/docs/self-hosting/public-agent',
  renderBlueprint: 'https://github.com/thunderbird/thunderbolt/blob/main/deploy/render/public-agent.yaml',
  docker: '/docs/self-hosting/docker-compose',
  kubernetes: '/docs/self-hosting/kubernetes',
  aws: '/docs/self-hosting/pulumi',
} as const

export const cliInstallCommand =
  'curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/install.sh | sh'

// Public store destinations can be filled in when the listings are available.
export const mobileStores = [
  { platform: 'iOS', store: 'App Store', status: 'Coming soon', href: undefined },
  { platform: 'Android', store: 'Google Play', status: 'Coming soon', href: undefined },
] as const
