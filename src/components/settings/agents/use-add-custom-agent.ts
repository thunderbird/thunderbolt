/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'

import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { createAgent } from '@/dal'
import { fireAndForgetSelfEnrollment, selfEnrollIrohNodeId } from '@/lib/iroh-enrollment'
import type { AddCustomAgentPayload } from './add-custom-agent-form'

type UseAddCustomAgentOptions = {
  /** Test/DI override for reading this app's iroh NodeId. */
  loadAppNodeId?: () => Promise<string>
  /** Test/DI override for app NodeId self-enrollment. */
  enrollIroh?: () => Promise<void>
}

/**
 * The shared "connect a custom ACP agent" submit handler: persists the endpoint
 * as a `remote-acp` agent, refreshes the agent list, and (for iroh targets)
 * fires off this app's NodeId self-enrollment. Used by both the standalone
 * connect panel and the add-agent panel's inline connect form.
 */
export const useAddCustomAgent = ({ loadAppNodeId, enrollIroh }: UseAddCustomAgentOptions = {}) => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const { data: session } = authClient.useSession()
  const currentUserId = session?.user?.id ?? null
  const runEnroll = enrollIroh ?? (() => selfEnrollIrohNodeId(httpClient, loadAppNodeId ?? irohClientNodeId))

  return async (payload: AddCustomAgentPayload) => {
    if (!currentUserId) {
      // Quick-create entry points are gated on capability, not session, so this
      // can be reached while auth is still resolving. Throwing routes it into
      // the form's catch, which shows the submit-failed error.
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
}
