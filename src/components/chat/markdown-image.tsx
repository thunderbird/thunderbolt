/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Components } from 'react-markdown'

// Untrusted Markdown must not trigger image requests or server-rendered image preloads.
export const markdownImageComponents: Components = {
  img: ({ alt }) => <span>{alt}</span>,
}
