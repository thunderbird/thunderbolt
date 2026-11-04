/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Bot, Brain, BookOpen, Plug } from 'lucide-react'
import type { ReactNode } from 'react'
import { EmojiPicker } from '@/projects/emoji-picker'
import { Accordion } from '@/components/ui/accordion'
import { AgentSettingsSection } from './agent-settings-section'
import { Link } from 'react-router'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { agentModels, agentModelPatch } from '@shared/cloud-agent/agent-models'
import { AgentModelsField } from './agent-models-field'
import { FormFooter } from '@/components/ui/form-footer'
import type { CloudModel } from '@shared/cloud-agent/contracts'
import type { CloudAgentClient, CloudAgentView, CloudConnectionView } from '@/cloud-agent/client'
import { useCloudAgentLibrary } from '@/cloud-agent/use-cloud-agent-library'
import { useCloudMcpLibrary } from '@/cloud-agent/use-cloud-mcp-library'
import { findCloudLibraryBinding } from '@/cloud-agent/connection-library'
import { cloudSkillSelection, resolveCloudModel, resolveCloudSkills } from '@/cloud-agent/library'
import { CloudError, CloudField } from './common'
import { useAgentEditorState } from './use-agent-editor-state'
import { selectedAgentMcps, resolveAgentMcps } from './agent-library-selection'

/** Agent settings select library capabilities; definitions and credentials are managed in Settings. */
export const CloudAgentEditor = ({
  client,
  agent,
  managedModel,
  connections,
  onSaved,
  onCancel,
  renderFrame,
}: {
  client: CloudAgentClient
  agent?: CloudAgentView
  managedModel: CloudModel | null
  connections: CloudConnectionView[]
  onSaved: (agent: CloudAgentView) => void
  onCancel: () => void
  renderFrame?: (content: ReactNode, icon: ReactNode) => ReactNode
}) => {
  const { t } = useLingui()
  const library = useCloudAgentLibrary()
  const mcp = useCloudMcpLibrary(connections)
  const modelChoices = library.models.map((model) => ({
    source: model,
    resolution: resolveCloudModel(model, {
      managedModel,
      binding: findCloudLibraryBinding({ kind: 'model', id: model.id }, connections),
    }),
  }))
  const { draft, patch, save, canSave } = useAgentEditorState({
    client,
    agent,
    managedModel,
    onSaved,
    resolveDraft: (current) => {
      const selected = cloudSkillSelection(current.skills)
      const models = agentModels(current).map((saved) => {
        const choice = modelChoices.find(
          ({ source, resolution }) =>
            source.id === saved.localModelId ||
            source.id === saved.model?.sourceId ||
            (!saved.localModelId &&
              resolution.ok &&
              resolution.model.provider === 'managed' &&
              saved.model?.provider === 'managed' &&
              resolution.model.modelId === saved.model.modelId),
        )
        return choice
          ? {
              localModelId: choice.source.id,
              name: choice.source.name,
              model: choice.resolution.ok ? choice.resolution.model : null,
            }
          : saved
      })
      const availableSkillIds = selected.ids.filter((id) => library.skills.some((skill) => skill.id === id))
      const savedMissingSkills = current.skills.filter(
        (skill) => skill.sourceId && !availableSkillIds.includes(skill.sourceId),
      )
      return {
        ...current,
        ...agentModelPatch(models),
        ...resolveAgentMcps(current, mcp.entries),
        skills: [...resolveCloudSkills(availableSkillIds, library.skills, selected.legacy), ...savedMissingSkills],
      }
    },
  })
  const skills = cloudSkillSelection(draft.skills)
  const savedSkills = draft.skills.filter(
    (skill) => !skill.sourceId || !library.skills.some((source) => source.id === skill.sourceId),
  )
  const unlistedConnections = connections.filter(
    ({ record, config }) =>
      config.kind === 'mcp' &&
      draft.connectionIds.includes(record.id) &&
      !mcp.entries.some((entry) => entry.cloudConnectionId === record.id),
  )
  const selectedMcps = selectedAgentMcps(draft, mcp.entries)
  const missingMcps = selectedMcps.filter((server) => !mcp.entries.some((entry) => entry.source.id === server.sourceId))
  const toggleLibraryConnection = (sourceId: string, name: string, enabled: boolean) => {
    const entry = mcp.entries.find((value) => value.source.id === sourceId)
    patch({
      mcpServers: enabled
        ? [...selectedMcps.filter((server) => server.sourceId !== sourceId), { sourceId, name }]
        : selectedMcps.filter((server) => server.sourceId !== sourceId),
      connectionIds: draft.connectionIds.filter((id) => id !== entry?.cloudConnectionId),
    })
  }
  const toggleConnection = (id: string, enabled: boolean) =>
    patch({
      connectionIds: enabled
        ? [...new Set([...draft.connectionIds, id])]
        : draft.connectionIds.filter((value) => value !== id),
    })
  const form = (
    <form
      className="flex flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave && !library.isLoading && !mcp.isPending) {
          save.mutate()
        }
      }}
    >
      <fieldset disabled={save.isPending || save.hasPrepared} className="flex flex-col gap-5">
        <CloudField label={<Trans>Name</Trans>}>
          <Input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            required
            autoFocus={!agent}
          />
        </CloudField>
        <CloudField label={<Trans>Description</Trans>}>
          <Input value={draft.description} onChange={(event) => patch({ description: event.target.value })} />
        </CloudField>
        <CloudField label={<Trans>Instructions</Trans>}>
          <Textarea
            value={draft.instructions}
            onChange={(event) => patch({ instructions: event.target.value })}
            rows={5}
            placeholder={t`Describe what this agent should do and how it should work.`}
            required
          />
        </CloudField>
        <Accordion type="single" collapsible defaultValue="model" className="border-y border-border/60">
          <AgentSettingsSection value="model" title={t`Models`} icon={<Brain />} count={agentModels(draft).length}>
            <AgentModelsField
              order={draft.modelOrder}
              onOrderChange={(modelOrder) => patch({ modelOrder })}
              models={agentModels(draft)}
              choices={modelChoices}
              onChange={(models) => patch(agentModelPatch(models))}
            />
          </AgentSettingsSection>
          <AgentSettingsSection
            value="mcp"
            title={t`Connections`}
            icon={<Plug />}
            count={selectedMcps.length + unlistedConnections.length + Number(draft.searchEnabled)}
          >
            <Link to="/settings/connections" className="self-end text-sm text-primary underline underline-offset-4">
              <Trans>Manage connections</Trans>
            </Link>
            {mcp.entries.map((entry) => {
              const checked = selectedMcps.some((server) => server.sourceId === entry.source.id)
              return (
                <label key={entry.server.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    <span className="block font-medium">{entry.server.name}</span>
                    {!entry.ready && (
                      <span className="text-muted-foreground">
                        {entry.eligible ? (
                          <Trans>Set up cloud access in Connections.</Trans>
                        ) : (
                          <Trans>Available only in its connected environment.</Trans>
                        )}
                      </span>
                    )}
                  </span>
                  <Switch
                    aria-label={t`Use ${entry.server.name}`}
                    checked={checked}
                    onCheckedChange={(enabled) => toggleLibraryConnection(entry.source.id, entry.source.name, enabled)}
                  />
                </label>
              )
            })}
            {missingMcps.map((server) => (
              <label key={server.sourceId} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {server.name}
                  <span className="block text-muted-foreground">
                    <Trans>Unavailable on this device</Trans>
                  </span>
                </span>
                <Switch
                  aria-label={t`Use ${server.name}`}
                  checked
                  onCheckedChange={() => toggleLibraryConnection(server.sourceId, server.name, false)}
                />
              </label>
            ))}
            {unlistedConnections.map(({ record, config }) => (
              <label key={record.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {config.name}
                  <span className="block text-muted-foreground">
                    <Trans>Link this saved connection in Connections.</Trans>
                  </span>
                </span>
                <Switch
                  aria-label={t`Use ${config.name}`}
                  checked
                  onCheckedChange={() => toggleConnection(record.id, false)}
                />
              </label>
            ))}
            {!mcp.isPending &&
              mcp.entries.length === 0 &&
              unlistedConnections.length === 0 &&
              missingMcps.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  <Trans>Add MCP servers in Connections to use them here.</Trans>
                </p>
              )}
            <CloudError error={mcp.error} />
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                <Trans>Web search</Trans>
              </span>
              <Switch checked={draft.searchEnabled} onCheckedChange={(searchEnabled) => patch({ searchEnabled })} />
            </label>
          </AgentSettingsSection>
          <AgentSettingsSection value="skill" title={t`Skills`} icon={<BookOpen />} count={draft.skills.length}>
            <Link to="/settings/skills" className="self-end text-sm text-primary underline underline-offset-4">
              <Trans>Manage skills</Trans>
            </Link>
            {library.skills.map((skill) => (
              <label key={skill.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="block font-medium">{skill.name}</span>
                  <span className="text-muted-foreground">{skill.description}</span>
                </span>
                <Switch
                  aria-label={t`Use ${skill.name}`}
                  checked={skills.ids.includes(skill.id)}
                  onCheckedChange={(enabled) =>
                    patch({
                      skills: enabled
                        ? [
                            ...draft.skills.filter((saved) => saved.sourceId !== skill.id),
                            {
                              sourceId: skill.id,
                              name: skill.name,
                              description: skill.description,
                              instruction: skill.instruction,
                            },
                          ]
                        : draft.skills.filter((saved) => saved.sourceId !== skill.id),
                    })
                  }
                />
              </label>
            ))}
            {savedSkills.map((skill, index) => (
              <label key={`saved-${index}`} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {skill.name}
                  <span className="block text-muted-foreground">
                    <Trans>Saved instructions</Trans>
                  </span>
                </span>
                <Switch
                  aria-label={t`Use ${skill.name}`}
                  checked
                  onCheckedChange={() => patch({ skills: draft.skills.filter((saved) => saved !== skill) })}
                />
              </label>
            ))}
            {!library.isLoading && library.skills.length === 0 && (
              <p className="text-sm text-muted-foreground">
                <Trans>Add skills in Settings to use them here.</Trans>
              </p>
            )}
          </AgentSettingsSection>
        </Accordion>
      </fieldset>
      <CloudError error={save.error} />
      <FormFooter>
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={onCancel}
          disabled={save.isPending}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!canSave || save.isPending || library.isLoading || mcp.isPending}>
          {save.isPending ? <Trans>Saving…</Trans> : save.hasPrepared ? <Trans>Retry save</Trans> : <Trans>Save</Trans>}
        </Button>
      </FormFooter>
    </form>
  )
  return renderFrame
    ? renderFrame(
        form,
        <EmojiPicker
          value={draft.icon ?? null}
          label={draft.name}
          fallbackIcon={<Bot className="size-5 text-muted-foreground" />}
          disabled={save.isPending || save.hasPrepared}
          onChange={(icon) => patch({ icon })}
        />,
      )
    : form
}
