/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PageDefinition } from '@shared/page-protocol'
import type { PageSession } from './page-store'

/** Navigation changes the current URL; local applications retain their device-bound identity. */
export const pageDefinitionForPin = (session: PageSession): PageDefinition => ({
  ...session.page,
  title: session.browser.title || session.page.title || URL.parse(session.browser.url)?.hostname || '',
  source: session.page.source.kind === 'url' ? { kind: 'url', url: session.browser.url } : session.page.source,
})

/** Blank browser documents are transient and cannot become a saved shortcut. */
export const canPinPage = (session: PageSession) =>
  session.page.source.kind !== 'url' || /^https?:\/\//.test(session.browser.url)
