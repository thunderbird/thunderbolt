/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig } from '@playwright/test'
import nightly from './playwright.nightly.config'

const webServers = Array.isArray(nightly.webServer) ? nightly.webServer : [nightly.webServer]

export default defineConfig({
  ...nightly,
  retries: 0,
  reporter: [['list']],
  projects: nightly.projects
    ?.filter((project) => project.name === 'consumer-webkit-desktop')
    .map((project) => ({ ...project, testMatch: /db-diagnostic\.case\.ts$/ })),
  webServer: webServers.filter((server) => server?.url?.includes(':1424') || server?.url?.includes(':8005')),
  use: { ...nightly.use, trace: 'off', video: 'off' },
})
