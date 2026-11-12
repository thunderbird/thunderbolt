/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PageDefinition, PageSnapshot } from '@shared/page-protocol'
import { isRecord } from '@shared/lib/is-record'

/** The text channel describes a screenshot's size; image bytes belong only in the image channel. */
export const pageSnapshotText = (output: Record<string, unknown>): string => {
  const { screenshot, ...page } = output
  return JSON.stringify({
    ...page,
    ...(isRecord(screenshot) ? { screenshotSize: { width: screenshot.width, height: screenshot.height } } : {}),
  })
}

/** Project a live observation into separate model text and image channels. */
export const pageSnapshotModelOutput = ({ output }: { output: PageSnapshot }) => ({
  type: 'content' as const,
  value: [
    { type: 'text' as const, text: pageSnapshotText(output) },
    ...(output.screenshot
      ? [{ type: 'image-data' as const, data: output.screenshot.data, mediaType: output.screenshot.mediaType }]
      : []),
  ],
})

/** The model needs the published file's identity, not a duplicate of its complete HTML source. */
export const showFileModelOutput = ({
  output,
}: {
  output:
    | {
        ok: true
        page: Pick<PageDefinition, 'id' | 'title'>
        sessionId?: string
        updated?: boolean
        presentation?: 'sidebar' | 'inline'
      }
    | { ok: false; errors: string[] }
}) => ({
  type: 'json' as const,
  value: output.ok
    ? {
        ok: true,
        pageId: output.page.id,
        title: output.page.title,
        ...(output.sessionId ? { sessionId: output.sessionId } : {}),
        ...(output.updated !== undefined ? { updated: output.updated } : {}),
        ...(output.presentation ? { presentation: output.presentation } : {}),
      }
    : output,
})
