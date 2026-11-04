/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { agentModels } from '@shared/cloud-agent/agent-models'
import { usePreparedSave } from './use-prepared-save'
import { cloudAgentConfigSchema } from '@/cloud-agent/validation'
import type { CloudModel } from '@shared/cloud-agent/contracts'
import type { CloudAgentClient, CloudAgentView, CloudAgentDraft } from '@/cloud-agent/client'

/** Initialize a private assistant without per-run limits and no granted connections. */
export const initialCloudAgentConfig = (model: CloudModel | null): CloudAgentDraft => ({
  name: '',
  description: '',
  instructions: '',
  model,
  skills: [],
  connectionIds: [],
  searchEnabled: false,
  approvalMode: 'ask',
  maxSteps: null,
  maxRunCostUsd: null,
})

/** Save configuration while preserving the activation state managed by the list. */
export const useAgentEditorState = ({
  client,
  agent,
  managedModel,
  onSaved,
  resolveDraft = (draft) => draft,
}: {
  client: CloudAgentClient
  agent?: CloudAgentView
  managedModel: CloudModel | null
  onSaved: (agent: CloudAgentView) => void
  resolveDraft?: (draft: CloudAgentDraft) => CloudAgentDraft
}) => {
  const [draft, patch] = useReducer(
    (state: CloudAgentDraft, value: Partial<CloudAgentDraft>) => ({ ...state, ...value }),
    agent?.config ?? initialCloudAgentConfig(managedModel),
  )
  const save = usePreparedSave({
    prepare: () => client.prepareAgent(resolveDraft(draft), agent?.record, agent?.record.enabled ?? true),
    submit: client.submitAgent,
    onSuccess: onSaved,
  })
  const hasModel = agentModels(draft).length > 0
  return {
    draft,
    patch,
    save,
    canSave:
      !!draft.name.trim() &&
      !!draft.instructions.trim() &&
      hasModel &&
      cloudAgentConfigSchema.omit({ ownerRecipient: true }).safeParse(draft).success,
  }
}
