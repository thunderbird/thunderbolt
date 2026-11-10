/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import browserPageDriver from '@/browser/page-driver.js?raw'
import iframePageDriver from '@/pages/iframe-page-driver.js?raw'
import { wrapArtifactHtml as wrapWithDrivers } from './harness-protocol'

export * from './harness-protocol'

/** Browser asset loading stays separate from the transport/pure HTML wrapper. */
export const wrapArtifactHtml = (html: string, nonce: string): string =>
  wrapWithDrivers(html, nonce, `${browserPageDriver}\n${iframePageDriver}`)
