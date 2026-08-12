/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Lets the assistant write a durable note into the project's knowledge — the
 * "remember this" half of Projects.
 *
 * Three guardrails, because a tool that writes into the user's own knowledge
 * base is not a normal tool:
 *
 * 1. **Opt-in per project.** Registered only when `agentNotesEnabled` is set, so
 *    a project never grows content the user didn't ask for.
 * 2. **Capped.** Notes land in the same context budget as the user's documents,
 *    and `getProjectFiles` sorts assistant notes *last* so they're evicted first —
 *    but a cap is still needed or the assistant could fill the list.
 * 3. **Visible and removable.** Notes are ordinary `project_files` rows tagged
 *    `origin: 'agent'`, so they appear in the Knowledge list with a badge and
 *    the same delete control as anything else. Nothing is written invisibly.
 */

import { tool, type Tool } from 'ai'
import { z } from 'zod'

import { addProjectFile, countAgentNotes, maxAgentNotes } from '@/dal/projects'
import type { AnyDrizzleDatabase } from '@/db/database-interface'

/** Keeps one note from consuming a meaningful slice of the knowledge budget. */
const maxNoteChars = 2_000

export type SaveNoteToolContext = {
  db: AnyDrizzleDatabase
  projectId: string
  projectName: string
}

export const createSaveProjectNoteTool = ({
  db,
  projectId,
  projectName,
}: SaveNoteToolContext): Tool<{ title: string; note: string }, string> =>
  tool({
    description:
      `Save a short, durable note into the "${projectName}" project's knowledge, so it is available in every future ` +
      'chat in this project. Use it for decisions, preferences, constraints, and facts the user will expect you to ' +
      'remember later — not for summarising the current conversation, and not for anything the user can trivially ' +
      'restate. The note is visible to the user and they can delete it.',
    inputSchema: z.object({
      title: z.string().describe('A short label, e.g. "Preferred tone" or "Q3 budget cap".'),
      note: z
        .string()
        .describe('The fact to remember, in one or two sentences. Write it to be understood months later.'),
    }),
    execute: async ({ title, note }) => {
      const trimmed = note.trim()
      if (trimmed.length === 0) {
        return 'Nothing was saved — the note was empty.'
      }
      const existing = await countAgentNotes(db, projectId)
      if (existing >= maxAgentNotes) {
        // Refuse rather than evict: deciding which of the user's remembered
        // facts to discard is not this tool's call to make.
        return `Not saved — this project already has the maximum of ${maxAgentNotes} saved notes. Ask the user to remove one first.`
      }
      const cleanTitle = title.trim() || 'Note'
      await addProjectFile(db, {
        projectId,
        filename: cleanTitle,
        content: trimmed.slice(0, maxNoteChars),
        sourceMimeType: 'text/plain',
        origin: 'agent',
      })
      return `Saved "${cleanTitle}" to project knowledge. It will be available in future chats in this project.`
    },
  })
