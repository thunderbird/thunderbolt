/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { staticCheckHtml } from '../../src/artifacts/static-check'

// Runs in WebKit's isolated client world, where DOMParser is available without
// executing any of the artifact's scripts during the static pass.
Object.assign(globalThis, {
  __thunderboltStaticCheck: async (html: string) => (await staticCheckHtml(html)).map((issue) => {
    if (issue.source === 'resource') return issue.message
    const location = issue.line ? ` (line ${issue.line}${issue.column ? `:${issue.column}` : ''})` : ''
    return `Invalid ${issue.source.toUpperCase()}${location}: ${issue.message}`
  }),
})
