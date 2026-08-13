/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One project: its icon and name, its instructions, its knowledge documents, and
 * its chats.
 *
 * Instructions and knowledge both feed the system prompt of every chat in the
 * project (see `src/projects/project-prompt.ts`), so this page shows the context
 * budget rather than letting a user silently exceed it.
 */

import { FileText, LayoutTemplate, MessageCirclePlus, NotebookPen, Sparkles, Trash2 } from 'lucide-react'
import { useReducer, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'

import { SettingsListBody, SettingsListPane } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Textarea } from '@/components/ui/textarea'
import { useDatabase } from '@/contexts'
import dayjs from 'dayjs'
import { Checkbox } from '@/components/ui/checkbox'
import {
  addProjectFile,
  maxProjectInstructionsLength,
  maxProjectNameLength,
  softDeleteProject,
  softDeleteProjectFile,
  updateProject,
  updateProjectFile,
  useProject,
  useProjectArtifacts,
  useProjectChats,
  useProjectFiles,
} from '@/dal/projects'
import { EmojiPicker } from './emoji-picker'
import { deletePrompt, detailReducer, initialDetailState, type NoteDraft } from './project-detail-state'
import { ProjectIcon } from './project-icon'

/** Fields and outline controls read as white against the warm page background
 *  (`--card` vs `--background`); `outline` buttons are transparent by default. */
const fieldClass = 'bg-card dark:bg-input'

/** A labelled section with its action on the title row, so the button lines up
 *  with the heading instead of floating above the content it applies to. */
const Section = ({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string
  action?: ReactNode
  children?: ReactNode
}) => (
  <section className="flex flex-col gap-2">
    <div className="flex min-h-[var(--touch-height-sm)] items-center justify-between gap-3">
      <span className="text-[length:var(--font-size-sm)] font-medium">{title}</span>
      {action}
    </div>
    {description && <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{description}</p>}
    {children}
  </section>
)

const ProjectDetailPage = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const db = useDatabase()
  const navigate = useNavigate()
  const [{ draftNote, pendingDelete, saveError }, dispatch] = useReducer(detailReducer, initialDetailState)

  // All reactive: an edit here, a new message in one of its chats, or a change
  // synced from another device all reach the page without a manual refetch.
  const { project, isLoading } = useProject(projectId)
  const files = useProjectFiles(projectId)
  const chats = useProjectChats(projectId)
  const artifacts = useProjectArtifacts(projectId)
  // Loading and missing are different states. The reactive query yields `null` on
  // its first tick, so redirecting on null alone bounces a valid project on a hard
  // refresh or a direct link.
  if (isLoading) {
    return <p className="p-4 text-[length:var(--font-size-sm)] text-muted-foreground">Loading…</p>
  }
  // Genuinely gone (deleted, or a stale link) — navigate rather than render an
  // empty shell. House rule: no navigation side effects in effects.
  if (!project) {
    return <Navigate to="/projects" replace />
  }

  /**
   * Persist one field edit, surfacing any failure instead of dropping it.
   *
   * `updateProject` throws `ProjectNameRequiredError` on a blank name, and React
   * does not await a blur handler — so without this the rejection is unhandled,
   * nothing is shown, and the row silently keeps its old value.
   */
  const saveField = async (patch: Parameters<typeof updateProject>[2]) => {
    try {
      await updateProject(db, project.id, patch)
      dispatch({ type: 'SAVE_SUCCEEDED' })
    } catch (error) {
      dispatch({
        type: 'SAVE_FAILED',
        error: { scope: 'field', message: error instanceof Error ? error.message : 'Could not save that change.' },
      })
    }
  }

  /** Same reason as `saveField`: React does not await this handler, so a failed
   *  write has to be caught here or the note silently vanishes. */
  const saveNote = async (draft: NoteDraft) => {
    try {
      if (draft.id) {
        await updateProjectFile(db, draft.id, { filename: draft.title, content: draft.content.trim() })
      } else {
        await addProjectFile(db, {
          projectId: project.id,
          filename: draft.title.trim() || 'Note',
          content: draft.content.trim(),
          sourceMimeType: 'text/plain',
          origin: 'note',
        })
      }
      dispatch({ type: 'NOTE_DISMISSED' })
    } catch (error) {
      dispatch({
        type: 'SAVE_FAILED',
        error: { scope: 'note', message: error instanceof Error ? error.message : 'Could not save that note.' },
      })
    }
  }

  // Both deletions are confirmed first: a project's instructions and knowledge
  // aren't recoverable from the UI, and a note's text exists nowhere else.
  const confirmDelete = async () => {
    if (!pendingDelete) {
      return
    }
    dispatch({ type: 'DELETE_DISMISSED' })
    if (pendingDelete.kind === 'project') {
      await softDeleteProject(db, project.id)
      navigate('/projects')
      return
    }
    await softDeleteProjectFile(db, pendingDelete.id)
  }

  return (
    // See the note in `index.tsx`: top-level pages clear the floating header's
    // scrim themselves; the settings layout does it for its own pages.
    <SettingsListPane className="md:pt-[var(--header-inset)]">
      <PageHeader title={project.name}>
        {/* `?projectId=` is read once at chat hydration and parked on the session,
            because the thread row isn't written until the first message. */}
        <Button
          variant="outline"
          size="sm"
          className={fieldClass}
          onClick={() => navigate(`/chats/new?projectId=${project.id}`)}
        >
          <MessageCirclePlus className="size-[var(--icon-size-sm)]" aria-hidden="true" />
          New chat
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: 'DELETE_REQUESTED', target: { kind: 'project' } })}
          aria-label="Delete project"
        >
          <Trash2 className="size-[var(--icon-size-sm)]" aria-hidden="true" />
        </Button>
      </PageHeader>

      <SettingsListBody className="gap-6">
        <Section title="Name">
          <div className="flex items-center gap-2">
            <EmojiPicker value={project.icon} label={project.name} onChange={(icon) => saveField({ icon })} />
            <Input
              aria-label="Project name"
              className={`flex-1 ${fieldClass}`}
              maxLength={maxProjectNameLength}
              // Keyed on `updatedAt` so the field remounts when the row changes —
              // an uncontrolled input keeps its mount-time value otherwise, so a
              // rename synced from another device (or a name trimmed on save)
              // would leave stale text while the title above it updated.
              key={`name-${project.updatedAt ?? project.id}`}
              defaultValue={project.name}
              onBlur={(event) => saveField({ name: event.target.value })}
            />
          </div>
          {saveError?.scope === 'field' && (
            <p role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
              {saveError.message}
            </p>
          )}
        </Section>

        <Section title="Instructions" description="Applied to every chat in this project.">
          <Textarea
            aria-label="Project instructions"
            className={fieldClass}
            rows={6}
            maxLength={maxProjectInstructionsLength}
            key={`instructions-${project.updatedAt ?? project.id}`}
            defaultValue={project.instructions ?? ''}
            placeholder="Reply in British English. Prefer bullet points over prose."
            onBlur={(event) => saveField({ instructions: event.target.value })}
          />
        </Section>

        <Section
          title="Knowledge"
          description="Documents attached in this project's chats land here automatically, stored as text so they sync across your devices."
          action={
            <Button
              variant="outline"
              size="sm"
              className={fieldClass}
              onClick={() => dispatch({ type: 'NOTE_DRAFTED', draft: { title: '', content: '' } })}
              disabled={draftNote !== null}
            >
              <NotebookPen className="size-[var(--icon-size-sm)]" aria-hidden="true" />
              Add note
            </Button>
          }
        >
          {draftNote && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 dark:bg-input">
              <Input
                autoFocus
                aria-label="Note title"
                className="bg-background dark:bg-background"
                placeholder="Title — e.g. “Tone of voice”"
                value={draftNote.title}
                onChange={(event) =>
                  dispatch({ type: 'NOTE_CHANGED', draft: { ...draftNote, title: event.target.value } })
                }
              />
              <Textarea
                aria-label="Note"
                className="bg-background dark:bg-background"
                rows={4}
                placeholder="Anything the assistant should know in every chat in this project."
                value={draftNote.content}
                onChange={(event) =>
                  dispatch({ type: 'NOTE_CHANGED', draft: { ...draftNote, content: event.target.value } })
                }
              />
              {saveError?.scope === 'note' && (
                <p role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
                  {saveError.message}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'NOTE_DISMISSED' })}>
                  Cancel
                </Button>
                <Button size="sm" disabled={draftNote.content.trim().length === 0} onClick={() => saveNote(draftNote)}>
                  {draftNote.id ? 'Save changes' : 'Save note'}
                </Button>
              </div>
            </div>
          )}
          {files.length === 0 && !draftNote ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-[length:var(--font-size-sm)] text-muted-foreground">
              No documents yet. Attach a file in one of this project’s chats and it will appear here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {files.map((file) => (
                <li
                  key={file.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card p-2 dark:bg-input"
                >
                  {file.origin === 'agent' ? (
                    <Sparkles
                      className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : file.origin === 'note' ? (
                    <NotebookPen
                      className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <FileText
                      className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  {/* Notes are editable in place; an imported document's text is
                      extracted from a file, so it stays read-only. */}
                  {file.origin === 'note' || file.origin === 'agent' ? (
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer truncate text-left text-[length:var(--font-size-sm)] hover:underline"
                      title={`Edit “${file.filename}”`}
                      onClick={() =>
                        dispatch({
                          type: 'NOTE_DRAFTED',
                          draft: { id: file.id, title: file.filename, content: file.content },
                        })
                      }
                    >
                      {file.filename}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[length:var(--font-size-sm)]" title={file.filename}>
                      {file.filename}
                    </span>
                  )}
                  {file.origin === 'agent' && (
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[length:var(--font-size-xs)] text-muted-foreground">
                      Saved by assistant
                    </span>
                  )}
                  {file.origin === 'chat' && (
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[length:var(--font-size-xs)] text-muted-foreground">
                      From chat
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${file.filename}`}
                    onClick={() =>
                      dispatch({
                        type: 'DELETE_REQUESTED',
                        target: { kind: 'file', id: file.id, filename: file.filename },
                      })
                    }
                  >
                    <Trash2 className="size-[var(--icon-size-sm)]" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Assistant memory">
          <label className="flex cursor-pointer items-start gap-3">
            <Checkbox
              checked={project.agentNotesEnabled === 1}
              onCheckedChange={(checked) => saveField({ agentNotesEnabled: checked === true })}
            />
            <span className="grid gap-1">
              <span className="text-[length:var(--font-size-sm)]">Let the assistant save notes to this project</span>
              <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
                It can write short facts and decisions into Knowledge above. Notes are labelled and you can delete them.
                Off by default.
              </span>
            </span>
          </label>
        </Section>

        <Section title="Artifacts" description="Pages and visuals the assistant rendered in this project's chats.">
          {artifacts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-[length:var(--font-size-sm)] text-muted-foreground">
              No artifacts yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {artifacts.map((artifact) => (
                <li key={`${artifact.messageId}-${artifact.title}`}>
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-start gap-2 py-2"
                    onClick={() => navigate(`/chats/${artifact.chatThreadId}`)}
                  >
                    <LayoutTemplate
                      className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{artifact.title}</span>
                    <span className="shrink-0 text-[length:var(--font-size-xs)] text-muted-foreground">
                      {artifact.chatTitle} · {dayjs(artifact.createdAt).fromNow()}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Chats">
          {chats.length === 0 ? (
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              No chats yet. Start one and it will use this project’s instructions and knowledge.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {chats.map((chat) => (
                <li key={chat.id}>
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={() => navigate(`/chats/${chat.id}`)}
                  >
                    <ProjectIcon icon={project.icon} className="size-4 text-[0.95rem]" />
                    <span className="min-w-0 flex-1 truncate text-left">{chat.title ?? 'Untitled chat'}</span>
                    <span
                      className="shrink-0 text-[length:var(--font-size-xs)] text-muted-foreground"
                      title={chat.lastActivityAt.toLocaleString()}
                    >
                      {dayjs(chat.lastActivityAt).fromNow()}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </SettingsListBody>

      {pendingDelete && (
        <ConfirmActionDialog
          open
          {...deletePrompt(pendingDelete)}
          onConfirm={confirmDelete}
          onCancel={() => dispatch({ type: 'DELETE_DISMISSED' })}
        />
      )}
    </SettingsListPane>
  )
}

export default ProjectDetailPage
