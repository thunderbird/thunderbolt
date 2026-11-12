/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { tool } from 'ai'
import { z } from 'zod'
import type { PageDefinition } from '@shared/page-protocol'
import { maxPageHtmlBytes, maxPageTitleLength, pageIdentifierSchema } from './page-schema'
import { verifyArtifactHtml, type ArtifactVerifyResult } from '@/artifacts/verify-html'
import { artifactRuntimeInstructions } from '@/artifacts/runtime-instructions'
import { showFileModelOutput } from './page-model-output'
import { workspacePageId } from './workspace-page-id'
import type { PagePublication, PublishPageOptions } from './publish-generated-page'

export const showFileToolName = 'page_show_file'
export type ShowFileOutput = ({ ok: true; page: PageDefinition } & PagePublication) | { ok: false; errors: string[] }
export type ShowFileToolOptions = {
  scope: string
  chatThreadId?: string
  cwd: string
  readFile: (path: string, signal?: AbortSignal) => Promise<string>
  onOpen: (page: PageDefinition, options: PublishPageOptions) => PagePublication | Promise<PagePublication>
  localAppsAvailable?: boolean
}

const showFileSchema = z.object({
  pageId: pageIdentifierSchema
    .optional()
    .describe(
      'Exact pageId from an earlier result to replace that page; otherwise the file keeps a stable page identity within this environment.',
    ),
  path: z
    .string()
    .min(1)
    .max(8192)
    .regex(/\.html$/i, 'Use a .html file from the current environment'),
  title: z.string().trim().min(1).max(maxPageTitleLength).optional(),
  presentation: z
    .enum(['sidebar', 'inline'])
    .optional()
    .describe(
      'Use sidebar for apps and interactive pages (default); inline for a graphic, chart, or illustration. Updates keep the current display placement.',
    ),
})

/** Publish a verified snapshot, so the page still works after a local workspace disappears. */
export const createShowFileTool = (
  options: ShowFileToolOptions,
  verify: (html: string) => Promise<ArtifactVerifyResult> = verifyArtifactHtml,
) =>
  tool<z.infer<typeof showFileSchema>, ShowFileOutput>({
    description: [
      'Show an HTML file created with the coding tools in the browser panel, or inline when explicitly requested for a small visual. Reads from the current project or standalone chat environment and publishes a synced snapshot. The .html file must be at most 2 MiB and self-contained: inline CSS/JS and data-URI images, with no network or external files. Verification errors are returned for you to fix before retrying.',
      artifactRuntimeInstructions,
      'Publishing the same file updates its existing page rather than opening another tab. Use presentation inline for a graphic or illustration intended to accompany the chat; apps default to the browser panel.',
      ...(options.localAppsAvailable
        ? [
            'Use local_app for projects needing a build, a server, multiple files, or durable data stored by a server in the project directory. Its allocated preview port can change, so do not assume browser storage survives server restarts.',
          ]
        : []),
    ].join(' '),
    inputSchema: showFileSchema,
    execute: async (raw, { abortSignal, toolCallId }): Promise<ShowFileOutput> => {
      const input = showFileSchema.parse(raw)
      abortSignal?.throwIfAborted()
      const html = await options.readFile(input.path, abortSignal)
      abortSignal?.throwIfAborted()
      if (new TextEncoder().encode(html).byteLength > maxPageHtmlBytes) {
        return { ok: false, errors: ['HTML pages must be no larger than 2 MiB'] }
      }
      const result = await verify(html)
      abortSignal?.throwIfAborted()
      if (!result.ok) {
        return { ok: false, errors: result.errors }
      }
      const page: PageDefinition = {
        id: input.pageId ?? workspacePageId(options.scope, options.cwd, input.path),
        title: input.title ?? (input.path.split(/[\\/]/).at(-1) ?? input.path).slice(0, maxPageTitleLength),
        source: { kind: 'html', html, artifact: { toolCallId, chatThreadId: options.chatThreadId } },
      }
      const publication = await options.onOpen(page, { presentation: input.presentation, signal: abortSignal })
      return { ok: true, page, ...publication, updated: !!input.pageId || publication.updated }
    },
    // The transcript retains the snapshot; the model already has the file and
    // only needs its published identity, not another copy of all its source.
    toModelOutput: showFileModelOutput,
  })
