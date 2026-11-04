/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useAuth } from '@/contexts'
import { useSignInModal } from '@/contexts/sign-in-modal-context'
import { Button } from '@/components/ui/button'
import { CloudAgentAccess } from '@/components/cloud-agent/cloud-agent-access'
import { CloudAgentSetup } from './cloud-agent-setup'
import { CloudError } from '@/components/cloud-agent/common'
import { useCloudAgentsState } from '@/components/cloud-agent/use-cloud-agents-state'
import type { CloudAgentView } from '@/cloud-agent/client'

type CloudAgentCreateProps = {
  onClose: () => void
  onBack?: () => void
  onSaved?: (agent: CloudAgentView) => void
}

const EnrolledCloudAgentCreate = ({
  ownerId,
  onClose,
  onBack,
  onSaved,
}: CloudAgentCreateProps & { ownerId: string }) => {
  const state = useCloudAgentsState(ownerId)
  if (state.capabilities.error || state.connections.error) {
    return <CloudError error={state.capabilities.error ?? state.connections.error} />
  }
  if (!state.capabilities.data) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading agent settings…</Trans>
      </p>
    )
  }
  if (!state.capabilities.data.enabled) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Cloud execution is not available on this server.</Trans>
      </p>
    )
  }
  if (state.connections.isPending) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading agent settings…</Trans>
      </p>
    )
  }
  return (
    <CloudAgentSetup
      client={state.client}
      managedModel={state.capabilities.data.managedModel}
      connections={state.connections.data ?? []}
      onCancel={onClose}
      onBack={onBack}
      onSaved={(agent) => {
        void state.refresh()
        if (onSaved) {
          onSaved(agent)
        } else {
          onClose()
        }
      }}
    />
  )
}

/** Saved agents use encrypted account storage and choose an execution environment in chat. */
export const CloudAgentCreate = (props: CloudAgentCreateProps) => {
  const auth = useAuth()
  const { data: session } = auth.useSession()
  const { openSignInModal } = useSignInModal()
  if (!session?.user.id || session.user.isAnonymous) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p>
          <Trans>Sign in to create a saved agent.</Trans>
        </p>
        <Button onClick={openSignInModal}>
          <Trans>Sign in</Trans>
        </Button>
      </div>
    )
  }
  return (
    <CloudAgentAccess ownerId={session.user.id}>
      <EnrolledCloudAgentCreate ownerId={session.user.id} {...props} />
    </CloudAgentAccess>
  )
}
