/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `get_app_context` for an open artifact.
 *
 * Same tool name the Mini App version registers, deliberately: from the user's
 * side both are "a thing on my screen I want to ask about", and the model
 * shouldn't need a different verb depending on which kind of rectangle it is.
 * Only one can be open at a time, so only one ever claims the name.
 *
 * Why this exists at all: without it the model answers questions about an
 * artifact by re-reading the HTML it generated, which is verbose, often no
 * longer in context, and describes the page as authored rather than as it now
 * stands after the user has clicked around in it.
 */

import type { ArtifactContext } from '@/artifacts/harness'
import { tool, type Tool } from 'ai'
import { z } from 'zod'

export type ArtifactContextToolDeps = {
  getSnapshot: () => { title: string | null; context: ArtifactContext | null }
}

/** Render the artifact's state for the model. */
export const formatArtifactContext = (title: string, context: ArtifactContext | null): string => {
  if (!context) {
    return `The user has the artifact "${title}" open, but it hasn't reported what it contains yet. Say that you can't see its contents rather than guessing from the HTML that produced it.`
  }
  return [
    `The user is looking at an artifact titled "${context.title}".`,
    'This is what it currently shows, read from the rendered page — so it reflects any interaction the user has had with it, which the original HTML would not:',
    context.summary,
  ].join('\n')
}

export const createArtifactContextTool = ({ getSnapshot }: ArtifactContextToolDeps): Tool =>
  tool({
    description:
      'Read what the artifact the user currently has open is showing. Use this before answering questions about a chart, table or page they are looking at, rather than working from the HTML that generated it — the artifact may have changed since.',
    inputSchema: z.object({}),
    execute: () => {
      const { title, context } = getSnapshot()
      if (!title) {
        return 'No artifact is open.'
      }
      return formatArtifactContext(title, context)
    },
  })
