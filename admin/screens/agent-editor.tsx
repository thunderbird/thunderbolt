/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useReducer, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { DetailPanel, DetailDivider } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { validateAgentUrl } from '@/components/settings/agents/validate-agent-url'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { createCompanyAgent, type PreviewAgent } from '../data'
import { originalAgentFixtures } from '../original-agent-fixtures'
import type { AdminPreview } from '../use-admin-preview-state'
import { AgentAccessPanel } from './agent-access-panel'
import { AgentEndpoint } from './agent-endpoint'
import { AgentPreview } from './agent-preview'
import { PanelSections } from './panel-sections'

type AgentDraft = Pick<PreviewAgent, 'name' | 'description' | 'category' | 'acpUrl'>
/** Config edits exclude grants so saving a draft cannot undo changes made on Access. */
const agentDraft = (agent?: PreviewAgent): AgentDraft => ({
  name: agent?.name ?? '',
  description: agent?.description ?? '',
  category: agent?.category ?? 'sealed',
  acpUrl: agent?.acpUrl ?? '',
})

const useAgentEditorState = (agent?: PreviewAgent) => {
  const [draft, patch] = useReducer(
    (state: AgentDraft, update: Partial<AgentDraft>) => ({ ...state, ...update }),
    agentDraft(agent),
  )
  const [section, setSection] = useState<'details' | 'access' | 'preview'>('details')
  const [removeOpen, setRemoveOpen] = useState(false)
  const saved = agentDraft(agent)
  const dirty = Object.keys(saved).some((key) => saved[key as keyof AgentDraft] !== draft[key as keyof AgentDraft])
  const validation = validateAgentUrl(draft.acpUrl.trim())
  const source = originalAgentFixtures.find((item) => item.acpUrl === draft.acpUrl.trim())
  return {
    draft,
    patch,
    dirty,
    source,
    validation,
    section,
    setSection,
    removeOpen,
    setRemoveOpen,
    canSave: 'transport' in validation && !!(draft.name.trim() || (!agent && source)),
    discard: () => patch(saved),
  }
}

export const AgentEditor = ({
  agent,
  preview,
  onClose,
}: {
  agent?: PreviewAgent
  preview: AdminPreview
  onClose: () => void
}) => {
  const { t, i18n } = useLingui()
  const editor = useAgentEditorState(agent)
  const { draft } = editor
  const save = () => {
    if (!editor.canSave) {
      return
    }
    const newAgent = createCompanyAgent()
    const base = agent ?? { ...newAgent, ...editor.source, id: newAgent.id }
    preview.dispatch({
      type: 'save-agent',
      agent: {
        ...base,
        ...draft,
        name: draft.name.trim() || editor.source?.name || '',
        acpUrl: draft.acpUrl.trim(),
        description: draft.description.trim(),
      },
    })
    if (!agent) {
      onClose()
    }
  }
  return (
    <DetailPanel
      title={agent?.name ?? t`Register agent`}
      subtitle={t`Company agent`}
      onClose={onClose}
      actions={
        agent && (
          <DetailActionsMenu>
            <DropdownMenuItem onClick={() => editor.setRemoveOpen(true)}>
              <Trash2 />
              <Trans>Remove agent</Trans>
            </DropdownMenuItem>
          </DetailActionsMenu>
        )
      }
    >
      {agent && (
        <PanelSections
          label={t`Agent sections`}
          sections={[
            { id: 'details', label: t`Details` },
            { id: 'access', label: t`Access` },
            { id: 'preview', label: t`Preview` },
          ]}
          value={editor.section}
          onChange={editor.setSection}
        />
      )}
      {editor.section === 'details' && (
        <>
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <DetailField
              label={
                <Label htmlFor="admin-agent-name">
                  <Trans>Name</Trans>
                </Label>
              }
            >
              <Input
                id="admin-agent-name"
                value={draft.name}
                placeholder={!agent ? t`Name from the agent’s endpoint` : undefined}
                onChange={(event) => editor.patch({ name: event.target.value })}
              />
            </DetailField>
            <DetailField
              label={
                <Label htmlFor="admin-agent-endpoint">
                  <Trans>ACP URL</Trans>
                </Label>
              }
            >
              <Input
                id="admin-agent-endpoint"
                required
                value={draft.acpUrl}
                placeholder={t`wss://agent.company.com/acp`}
                onChange={(event) => editor.patch({ acpUrl: event.target.value })}
                aria-invalid={!!draft.acpUrl && 'error' in editor.validation}
              />
              {!!draft.acpUrl && 'error' in editor.validation && (
                <p role="alert" className="text-sm text-destructive">
                  {i18n._(editor.validation.error)}
                </p>
              )}
            </DetailField>
            <DetailField label={<Trans>Category</Trans>}>
              <Select
                value={draft.category}
                onValueChange={(category) => {
                  if (category === 'sealed' || category === 'extensible') {
                    editor.patch({ category })
                  }
                }}
              >
                <SelectTrigger aria-label={t`Category`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sealed">
                    <Trans>Sealed</Trans>
                  </SelectItem>
                  <SelectItem value="extensible">
                    <Trans>Extensible</Trans>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {draft.category === 'sealed' ? (
                  <Trans>Runs only what it came with. Members’ library skills are not shared with it.</Trans>
                ) : (
                  <Trans>Members’ enabled library skills and integrations are available to this agent.</Trans>
                )}
              </p>
            </DetailField>
            <DetailField
              label={
                <Label htmlFor="admin-agent-description">
                  <Trans>About</Trans>
                </Label>
              }
            >
              <Textarea
                id="admin-agent-description"
                value={draft.description}
                onChange={(event) => editor.patch({ description: event.target.value })}
              />
              <p className="text-sm text-muted-foreground">
                <Trans>This is what members read to learn what the agent does.</Trans>
              </p>
            </DetailField>
            {(editor.dirty || !agent) && (
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={!editor.canSave}>
                  {agent ? <Trans>Save changes</Trans> : <Trans>Register agent</Trans>}
                </Button>
                <Button type="button" variant="ghost" onClick={agent ? editor.discard : onClose}>
                  {agent ? <Trans>Discard</Trans> : <Trans>Cancel</Trans>}
                </Button>
              </div>
            )}
          </form>
          {agent && (
            <>
              <DetailDivider />
              <AgentEndpoint key={agent.acpUrl} acpUrl={agent.acpUrl} />
            </>
          )}
        </>
      )}
      {agent && editor.section === 'access' && <AgentAccessPanel agent={agent} preview={preview} />}
      {agent && editor.section === 'preview' && <AgentPreview agent={{ ...agent, ...draft }} />}
      {agent && (
        <AlertDialog open={editor.removeOpen} onOpenChange={editor.setRemoveOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Remove {agent.name}?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>This removes the agent from the organization’s list.</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  preview.dispatch({ type: 'remove', kind: 'agents', id: agent.id, at: Date.now() })
                  onClose()
                }}
              >
                <Trans>Remove agent</Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </DetailPanel>
  )
}
