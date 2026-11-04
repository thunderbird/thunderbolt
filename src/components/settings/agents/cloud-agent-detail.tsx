/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { Bot } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CloudModel } from '@shared/cloud-agent/contracts'
import type { CloudAgentClient, CloudAgentView, CloudConnectionView } from '@/cloud-agent/client'
import { DetailPanel } from '@/components/detail-panel'
import { IconTile } from '@/components/settings/icon-tile'
import { CloudAgentEditor } from '@/components/cloud-agent/agent-editor'
import { CloudSchedules } from '@/components/cloud-agent/schedules'
import { CloudTabs } from '@/components/cloud-agent/common'
import { useIsMobile } from '@/hooks/use-mobile'

export type AgentDetailView = 'settings' | 'schedules'

/** The ordinary agent aside also owns a portable saved agent. */
export const CloudAgentDetail = ({
  client,
  agent,
  connections,
  managedModel,
  view,
  onViewChange,
  onClose,
  onSaved,
}: {
  client: CloudAgentClient
  agent: CloudAgentView
  connections: CloudConnectionView[]
  managedModel: CloudModel | null
  view: AgentDetailView
  onViewChange: (view: AgentDetailView) => void
  onClose: () => void
  onSaved: (agent: CloudAgentView) => void
}) => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const renderFrame = (content: ReactNode, icon: ReactNode) => (
    <DetailPanel
      title={agent.config.name}
      subtitle={t`Thunderbolt agent`}
      onClose={onClose}
      pinFormFooter={view === 'settings'}
      icon={icon}
    >
      <CloudTabs
        value={view}
        onChange={onViewChange}
        options={[
          { id: 'settings', label: t`Settings` },
          { id: 'schedules', label: t`Schedules` },
        ]}
      />
      {isMobile && view === 'settings' && <div>{icon}</div>}
      {content}
    </DetailPanel>
  )
  if (view === 'settings') {
    return (
      <CloudAgentEditor
        key={`${agent.record.id}:${agent.record.version}`}
        client={client}
        agent={agent}
        managedModel={managedModel}
        connections={connections}
        onSaved={onSaved}
        onCancel={onClose}
        renderFrame={renderFrame}
      />
    )
  }
  return renderFrame(
    <CloudSchedules client={client} agent={agent} />,
    <IconTile>{agent.config.icon ?? <Bot className="size-5 text-muted-foreground" />}</IconTile>,
  )
}
