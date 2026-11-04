/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { agentModelPatch } from '@shared/cloud-agent/agent-models'
import { Brain } from 'lucide-react'
import { AgentSettingsSection } from '@/components/cloud-agent/agent-settings-section'
import { AgentModelsField } from '@/components/cloud-agent/agent-models-field'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import type { CloudModel } from '@shared/cloud-agent/contracts'
import type { CloudAgentClient, CloudAgentView, CloudConnectionView } from '@/cloud-agent/client'
import { resolveCloudModel, resolveCloudSkills } from '@/cloud-agent/library'
import { findCloudLibraryBinding } from '@/cloud-agent/connection-library'
import { useCloudAgentLibrary } from '@/cloud-agent/use-cloud-agent-library'
import { useCloudMcpLibrary } from '@/cloud-agent/use-cloud-mcp-library'
import { CloudError } from '@/components/cloud-agent/common'
import { initialCloudAgentConfig } from '@/components/cloud-agent/use-agent-editor-state'
import { usePreparedSave } from '@/components/cloud-agent/use-prepared-save'
import { CreateModelPanel } from '@/components/create-item/create-model-panel'
import { CreateSkillPanel } from '@/components/create-item/create-skill-panel'
import { AgentBasicsForm } from './add-agent/agent-basics-form'
import { ThunderboltAgentForm } from './add-agent/thunderbolt-agent-form'
import { useAddAgentState } from './add-agent/use-add-agent-state'
import type { AgentSetupSuggester } from './add-agent/agent-setup-suggestion'
import { useAgentSetupSuggester } from './add-agent/use-agent-setup-suggester'
import { CreateConnectionPanel } from './add-agent/create-connection-panel'
import type { AgentResource, AgentResourceKind } from './add-agent/types'

/** The shared purpose-first aside creates an encrypted portable agent, enabled by default. */
export const CloudAgentSetup = ({
  client,
  managedModel,
  connections,
  onSaved,
  onCancel,
  onBack = onCancel,
  suggestSetup,
}: {
  client: CloudAgentClient
  managedModel: CloudModel | null
  connections: CloudConnectionView[]
  onSaved: (agent: CloudAgentView) => void
  onCancel: () => void
  onBack?: () => void
  suggestSetup?: AgentSetupSuggester
}) => {
  const { t } = useLingui()
  const library = useCloudAgentLibrary()
  const mcp = useCloudMcpLibrary(connections)
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState<AgentResourceKind | null>(null)
  const models = library.models.map((source) => ({
    source,
    resolution: resolveCloudModel(source, {
      managedModel,
      binding: findCloudLibraryBinding({ kind: 'model', id: source.id }, connections),
    }),
  }))
  const resources: AgentResource[] = [
    { id: 'search:exa', kind: 'mcp', scope: 'personal', name: t`Web search`, description: 'Exa' },
    ...models.map(({ source, resolution }, index) => ({
      id: `model:${source.id}`,
      kind: 'model' as const,
      scope: 'personal' as const,
      name: source.name,
      description: resolution.ok ? '' : t`Cloud access not configured`,
      defaultSelected:
        index ===
        Math.max(
          0,
          models.findIndex((model) => model.resolution.ok),
        ),
    })),
    ...mcp.entries.map((entry) => ({
      id: `mcp:${entry.source.id}`,
      kind: 'mcp' as const,
      scope: 'personal' as const,
      name: entry.source.name,
      description: entry.ready ? '' : t`Cloud access not configured`,
    })),
    ...library.skills.map((skill) => ({
      id: `skill:${skill.id}`,
      kind: 'skill' as const,
      scope: 'personal' as const,
      name: skill.name,
      description: skill.description,
    })),
  ]
  const suggest = useAgentSetupSuggester()
  const state = useAddAgentState(resources, false, suggestSetup ?? suggest, true)
  const selectedModels = state.selectedResources
    .filter((resource) => resource.kind === 'model')
    .map((resource) => models.find(({ source }) => `model:${source.id}` === resource.id)!)
    .sort(
      (a, b) =>
        (state.draft.modelOrder?.indexOf(a.source.id) ?? 0) - (state.draft.modelOrder?.indexOf(b.source.id) ?? 0),
    )
    .map(({ source, resolution }) => ({
      localModelId: source.id,
      name: source.name,
      model: resolution.ok ? resolution.model : null,
    }))
  const save = usePreparedSave({
    prepare: () => {
      const selected = state.selectedResources
      if (selectedModels.length === 0) {
        throw new Error(t`Choose a model.`)
      }
      const selectedMcpIds = new Set(
        selected.filter((resource) => resource.id.startsWith('mcp:')).map((resource) => resource.id.slice(4)),
      )
      const selectedMcps = mcp.entries.filter((entry) => selectedMcpIds.has(entry.source.id))
      return client.prepareAgent(
        {
          ...initialCloudAgentConfig(managedModel),
          name: state.draft.name.trim(),
          description: state.draft.description.trim(),
          instructions: state.draft.systemPrompt.trim() || state.draft.description.trim(),
          ...agentModelPatch(selectedModels),
          modelOrder: state.draft.modelOrder,
          skills: resolveCloudSkills(
            selected.filter((resource) => resource.kind === 'skill').map((resource) => resource.id.slice(6)),
            library.skills,
            [],
          ),
          searchEnabled: selected.some((resource) => resource.id === 'search:exa'),
          mcpServers: selectedMcps.map((entry) => ({ sourceId: entry.source.id, name: entry.source.name })),
          connectionIds: selectedMcps.flatMap((entry) =>
            entry.ready && entry.cloudConnectionId ? [entry.cloudConnectionId] : [],
          ),
        },
        undefined,
        true,
      )
    },
    submit: client.submitAgent,
    onSuccess: onSaved,
  })
  const controller = {
    ...state,
    back: state.step === 'basics' ? onBack : state.back,
  }
  const closeResource = () => {
    setAdding(null)
    void queryClient.invalidateQueries()
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <fieldset disabled={save.isPending || save.hasPrepared} className="flex min-w-0 flex-1 flex-col">
        {state.step === 'basics' ? (
          <AgentBasicsForm controller={controller} desktopAvailable={false} onClose={onCancel} />
        ) : (
          <ThunderboltAgentForm
            controller={controller}
            resources={resources}
            onClose={onCancel}
            onCreate={() => save.mutate()}
            saving={save.isPending}
            onAddResource={setAdding}
            modelsField={
              <AgentSettingsSection value="model" title={t`Models`} icon={<Brain />} count={selectedModels.length}>
                <AgentModelsField
                  order={state.draft.modelOrder}
                  onOrderChange={(modelOrder) => state.edit({ modelOrder })}
                  models={selectedModels}
                  choices={models}
                  onChange={(next) => {
                    models.forEach(({ source }) =>
                      state.toggle(
                        `model:${source.id}`,
                        next.some((entry) => entry.localModelId === source.id),
                      ),
                    )
                  }}
                />
              </AgentSettingsSection>
            }
          />
        )}
      </fieldset>
      <CloudError error={save.error ?? mcp.error} />
      {save.hasPrepared && save.isError && <button type="button" onClick={() => save.mutate()}>{t`Retry save`}</button>}
      {adding === 'model' && <CreateModelPanel open overlay onClose={closeResource} onCloseComplete={closeResource} />}
      {adding === 'skill' && <CreateSkillPanel open overlay onClose={closeResource} onCloseComplete={closeResource} />}
      {adding === 'mcp' && <CreateConnectionPanel onClose={closeResource} />}
    </div>
  )
}
