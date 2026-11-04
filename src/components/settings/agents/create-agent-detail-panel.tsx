/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { v7 as uuidv7 } from 'uuid'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { testAcpConnection } from '@/acp'
import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { DetailPanel } from '@/components/detail-panel'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { createAgent } from '@/dal'
import { fireAndForgetSelfEnrollment, selfEnrollIrohNodeId } from '@/lib/iroh-enrollment'
import { createItemTitles } from '@/components/create-item/context'
import { AddCustomAgentForm, type AddCustomAgentPayload } from './add-custom-agent-form'
import { ChoiceCard } from './add-agent/choice-card'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { ArrowRight, Bot, Plug } from 'lucide-react'
import { CloudAgentCreate } from './cloud-agent-create'
import type { CloudAgentView } from '@/cloud-agent/client'

type CreateAgentDetailPanelProps = {
  onClose: () => void
  /** Test/DI override for reading this app's iroh NodeId. */
  loadAppNodeId?: () => Promise<string>
  /** Test/DI override for app NodeId self-enrollment. */
  enrollIroh?: () => Promise<void>
  onCloudSaved?: (agent: CloudAgentView) => void
}

/** Shared custom-agent creation controller used in settings and quick create. */
export const CreateAgentDetailPanel = ({
  onClose,
  loadAppNodeId,
  enrollIroh,
  onCloudSaved,
}: CreateAgentDetailPanelProps) => {
  const [agentType, setAgentType] = useState<'thunderbolt' | 'remote' | null>(null)
  const [choice, setChoice] = useState<'thunderbolt' | 'remote'>('thunderbolt')
  const { i18n, t } = useLingui()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const runEnroll = enrollIroh ?? (() => selfEnrollIrohNodeId(httpClient, loadAppNodeId ?? irohClientNodeId))

  const handleAdd = async (payload: AddCustomAgentPayload) => {
    if (!currentUserId) {
      // Quick-create entry points are gated on capability, not session, so
      // this can be reached while auth is still resolving. Throwing routes it
      // into the form's catch, which shows the submit-failed error.
      throw new Error('Cannot create an agent without an authenticated session.')
    }
    await createAgent(db, {
      id: uuidv7(),
      name: payload.name,
      type: 'remote-acp',
      transport: payload.transport,
      url: payload.url,
      description: payload.description,
      enabled: 1,
      userId: currentUserId,
    })
    await queryClient.invalidateQueries({ queryKey: ['agents'] })
    if (payload.transport === 'iroh') {
      fireAndForgetSelfEnrollment(runEnroll)
    }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <DetailPanel title={i18n._(createItemTitles.agent)} onClose={onClose} pinFormFooter>
        {agentType === null && (
          <>
            <fieldset className="grid gap-2">
              <legend className="sr-only">
                <Trans>Agent type</Trans>
              </legend>
              <ChoiceCard
                name="agent-type"
                value="thunderbolt"
                title={t`Create Thunderbolt agent`}
                icon={<Bot />}
                checked={choice === 'thunderbolt'}
                onSelect={() => setChoice('thunderbolt')}
              />
              <ChoiceCard
                name="agent-type"
                value="remote"
                title={t`Connect to ACP agent`}
                icon={<Plug />}
                checked={choice === 'remote'}
                onSelect={() => setChoice('remote')}
              />
            </fieldset>
            <FormFooter>
              <Button variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={onClose}>
                <Trans>Cancel</Trans>
              </Button>
              <Button onClick={() => setAgentType(choice)}>
                <Trans>Continue</Trans>
                <ArrowRight className="size-4" />
              </Button>
            </FormFooter>
          </>
        )}
        {agentType === 'thunderbolt' ? (
          <CloudAgentCreate onBack={() => setAgentType(null)} onClose={onClose} onSaved={onCloudSaved} />
        ) : agentType === 'remote' ? (
          <AddCustomAgentForm
            onClose={onClose}
            onSubmit={handleAdd}
            testAcpConnection={testAcpConnection}
            loadAppNodeId={loadAppNodeId}
          />
        ) : null}
      </DetailPanel>
    </div>
  )
}
