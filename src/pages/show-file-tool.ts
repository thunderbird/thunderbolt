/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { tool } from 'ai'
import { z } from 'zod'
import type { PageDefinition } from '@shared/page-protocol'
import { verifyArtifactHtml, type ArtifactVerifyResult } from '@/artifacts/verify-html'

export const showFileToolName = 'page_show_file'
export type ShowFileOutput = { ok: true; page: PageDefinition } | { ok: false; errors: string[] }
export type ShowFileToolOptions = {
  readFile: (path: string, signal?: AbortSignal) => Promise<string>
  onOpen: (page: PageDefinition) => unknown | Promise<unknown>
}

const showFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(8192)
    .regex(/\.html$/i, 'Use a .html file from the current environment'),
  title: z.string().trim().min(1).max(200).optional(),
})

/** Publish a verified snapshot, so the page still works after a local workspace disappears. */
export const createShowFileTool = (
  options: ShowFileToolOptions,
  verify: (html: string) => Promise<ArtifactVerifyResult> = verifyArtifactHtml,
) =>
  tool({
    description:
      'Show an HTML file created with the coding tools as an inline chat artifact and in the browser panel. Reads from the current project or standalone chat environment and publishes a synced snapshot. The .html file must be at most 2 MiB and self-contained: inline CSS/JS and data-URI images, with no network or external files. Verification errors are returned for you to fix before retrying. Use local_app for projects needing a build, a server, or multiple files.',
    inputSchema: showFileSchema,
    execute: async (raw, { abortSignal }): Promise<ShowFileOutput> => {
      const input = showFileSchema.parse(raw)
      abortSignal?.throwIfAborted()
      const html = await options.readFile(input.path, abortSignal)
      abortSignal?.throwIfAborted()
      if (new TextEncoder().encode(html).byteLength > 2 * 1024 * 1024) {
        return { ok: false, errors: ['HTML pages must be no larger than 2 MiB'] }
      }
      const result = await verify(html)
      abortSignal?.throwIfAborted()
      if (!result.ok) {
        return { ok: false, errors: result.errors }
      }
      const page: PageDefinition = {
        id: crypto.randomUUID(),
        title: input.title ?? input.path.split(/[\\/]/).at(-1) ?? input.path,
        source: { kind: 'html', html },
      }
      await options.onOpen(page)
      return { ok: true, page }
    },
    // The transcript retains the snapshot; the model already has the file and
    // only needs its published identity, not another copy of all its source.
    toModelOutput: ({ output }) => ({
      type: 'json',
      value: output.ok ? { ok: true, pageId: output.page.id, title: output.page.title } : output,
    }),
  })
