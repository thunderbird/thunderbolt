/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { downloadFile } from '@/lib/download'
import { wrapArtifactPreviewHtml } from './harness'

/** Export a standalone HTML file with the same offline policy as the in-app artifact. */
export const downloadArtifactHtml = async (html: string, title: string): Promise<void> => {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'artifact'
  await downloadFile({ name: `${slug}.html`, contents: wrapArtifactPreviewHtml(html), mimeType: 'text/html' })
}
