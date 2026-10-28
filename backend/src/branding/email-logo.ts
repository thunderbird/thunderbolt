/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { configRoutesPrefix, emailLogoRoute } from '@/api/config-paths'
import type { Settings } from '@/config/settings'

/**
 * The bundled mark emails show when there is no operator logo they can render.
 *
 * @param appUrl - `APP_URL`, which serves the web app's public files.
 */
export const bundledEmailLogoUrl = (appUrl: string): string => `${appUrl}/email-logo.png`

/**
 * The header logo emails embed. With an operator logo it is the backend's own
 * copy, which the email-logo route serves when email clients can show it and
 * otherwise redirects to the bundled mark: emails never point at the
 * operator's logo host, so opening one tells that host nothing.
 *
 * @param settings - The backend settings.
 */
export const emailLogoUrl = (settings: Pick<Settings, 'branding' | 'betterAuthUrl' | 'appUrl'>): string =>
  settings.branding?.logo
    ? `${new URL(settings.betterAuthUrl).origin}/v1${configRoutesPrefix}${emailLogoRoute}`
    : bundledEmailLogoUrl(settings.appUrl)
