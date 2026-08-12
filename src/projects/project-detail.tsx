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

import { useQuery } from '@tanstack/react-query'
import { FileText, LayoutTemplate, MessageCirclePlus, NotebookPen, Sparkles, Trash2, Upload } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'

import { SettingsListBody, SettingsListPane } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Textarea } from '@/components/ui/textarea'
import { useDatabase } from '@/contexts'
import dayjs from 'dayjs'
import { Checkbox } from '@/components/ui/checkbox'
import {
  addProjectFile,
  getProject,
  getProjectArtifacts,
  getProjectChatSummaries,
  maxProjectInstructionsLength,
  softDeleteProject,
  softDeleteProjectFile,
  updateProject,
  updateProjectFile,
  useProjectFiles,
} from '@/dal/projects'
import { EmojiPicker } from './emoji-picker'
import { importKnowledgeFiles, summarizeImport } from './import-knowledge-files'
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
  const fileInput = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  // `id` present = editing an existing note; absent = composing a new one.
  const [draftNote, setDraftNote] = useState<{ id?: string; title: string; content: string } | null>(null)

  const {
    data: project,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(db, projectId ?? ''),
    enabled: Boolean(projectId),
  })
  const files = useProjectFiles(projectId)
  const { data: chats = [] } = useQuery({
    queryKey: ['projectChats', projectId],
    queryFn: () => getProjectChatSummaries(db, projectId ?? ''),
    enabled: Boolean(projectId),
  })
  const { data: artifacts = [] } = useQuery({
    queryKey: ['projectArtifacts', projectId],
    queryFn: () => getProjectArtifacts(db, projectId ?? ''),
    enabled: Boolean(projectId),
  })

  if (isLoading) {
    return <p className="p-4 text-[length:var(--font-size-sm)] text-muted-foreground">Loading…</p>
  }
  // A deleted project (or a stale link) navigates rather than rendering an
  // empty shell — house rule: no navigation side effects in effects.
  if (!project) {
    return <Navigate to="/projects" replace />
  }

  const handleImport = async (fileList: FileList | null) => {
    if (!fileList?.length) {
      return
    }
    setIsImporting(true)
    setNotice(null)
    const result = await importKnowledgeFiles(Array.from(fileList))
    for (const doc of result.documents) {
      await addProjectFile(db, {
        projectId: project.id,
        filename: doc.filename,
        sourceMimeType: doc.sourceMimeType,
        content: doc.content,
      })
    }
    setNotice(summarizeImport(result))
    setIsImporting(false)
  }

  const handleDelete = async () => {
    await softDeleteProject(db, project.id)
    navigate('/projects')
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
        <Button variant="ghost" size="sm" onClick={handleDelete} aria-label="Delete project">
          <Trash2 className="size-[var(--icon-size-sm)]" aria-hidden="true" />
        </Button>
      </PageHeader>

      <SettingsListBody className="gap-6">
        <Section title="Name">
          <div className="flex items-center gap-2">
            <EmojiPicker
              value={project.icon}
              label={project.name}
              onChange={async (icon) => {
                await updateProject(db, project.id, { icon })
                await refetch()
              }}
            />
            <Input
              aria-label="Project name"
              className={`flex-1 ${fieldClass}`}
              defaultValue={project.name}
              onBlur={async (event) => {
                await updateProject(db, project.id, { name: event.target.value })
                await refetch()
              }}
            />
          </div>
        </Section>

        <Section title="Instructions" description="Applied to every chat in this project.">
          <Textarea
            aria-label="Project instructions"
            className={fieldClass}
            rows={6}
            maxLength={maxProjectInstructionsLength}
            defaultValue={project.instructions ?? ''}
            placeholder="Reply in British English. Prefer bullet points over prose."
            onBlur={async (event) => {
              await updateProject(db, project.id, { instructions: event.target.value })
              await refetch()
            }}
          />
        </Section>

        <Section
          title="Knowledge"
          description="Stored as text so it syncs across your devices. PDFs, Word documents, and plain text are supported."
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className={fieldClass}
                onClick={() => setDraftNote({ title: '', content: '' })}
                disabled={draftNote !== null}
              >
                <NotebookPen className="size-[var(--icon-size-sm)]" aria-hidden="true" />
                Add note
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={fieldClass}
                disabled={isImporting}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="size-[var(--icon-size-sm)]" aria-hidden="true" />
                Add files
              </Button>
            </div>
          }
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => handleImport(event.target.files)}
          />
          {notice && (
            <p role="status" className="text-[length:var(--font-size-sm)] text-muted-foreground">
              {notice}
            </p>
          )}
          {draftNote && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 dark:bg-input">
              <Input
                autoFocus
                aria-label="Note title"
                className="bg-background dark:bg-background"
                placeholder="Title — e.g. “Tone of voice”"
                value={draftNote.title}
                onChange={(event) => setDraftNote({ ...draftNote, title: event.target.value })}
              />
              <Textarea
                aria-label="Note"
                className="bg-background dark:bg-background"
                rows={4}
                placeholder="Anything the assistant should know in every chat in this project."
                value={draftNote.content}
                onChange={(event) => setDraftNote({ ...draftNote, content: event.target.value })}
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDraftNote(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={draftNote.content.trim().length === 0}
                  onClick={async () => {
                    if (draftNote.id) {
                      await updateProjectFile(db, draftNote.id, {
                        filename: draftNote.title,
                        content: draftNote.content.trim(),
                      })
                    } else {
                      await addProjectFile(db, {
                        projectId: project.id,
                        filename: draftNote.title.trim() || 'Note',
                        content: draftNote.content.trim(),
                        sourceMimeType: 'text/plain',
                        origin: 'note',
                      })
                    }
                    setDraftNote(null)
                  }}
                >
                  {draftNote.id ? 'Save changes' : 'Save note'}
                </Button>
              </div>
            </div>
          )}
          {files.length === 0 && !draftNote ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-[length:var(--font-size-sm)] text-muted-foreground">
              No documents yet.
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
                      onClick={() => setDraftNote({ id: file.id, title: file.filename, content: file.content })}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${file.filename}`}
                    onClick={() => softDeleteProjectFile(db, file.id)}
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
              onCheckedChange={async (checked) => {
                await updateProject(db, project.id, { agentNotesEnabled: checked === true })
                await refetch()
              }}
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
    </SettingsListPane>
  )
}

export default ProjectDetailPage
