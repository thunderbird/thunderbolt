/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { AppLogo } from '@/components/app-logo'
import { DetailPanel } from '@/components/detail-panel'
import { AgentUsageSummary } from '@/components/settings/agents/agent-usage-summary'
import { IconTile } from '@/components/settings/icon-tile'
import { builtInAgent } from '@/defaults/agents'
import type { AdminPreview } from '../use-admin-preview-state'

export const ThunderboltAgentPanel = ({ preview, onClose }: { preview: AdminPreview; onClose: () => void }) => {
  const { t } = useLingui()
  const skills = preview.companySkills.filter((skill) => skill.enabled).length
  const connections = preview.companyMcpServers.filter((server) => server.enabled === 1).length
  const models = preview.companyModels.filter((model) => model.enabled === 1).length

  return (
    <DetailPanel
      title={builtInAgent.name}
      subtitle={t`Built-in · Everyone`}
      onClose={onClose}
      icon={
        <IconTile>
          <AppLogo className="size-5.5 text-muted-foreground" aria-hidden="true" />
        </IconTile>
      }
    >
      <AgentUsageSummary
        about={
          <Trans>
            Thunderbolt is the agent built into the app. Everyone in your company can use it with the skills,
            connections, and models enabled by your organization.
          </Trans>
        }
        resources={[
          {
            label: t`Skills`,
            summary: <Plural value={skills} one="# skill" other="# skills" />,
            to: '/admin/thunderbolt/skills',
          },
          {
            label: t`Connections`,
            summary: <Plural value={connections} one="# connection" other="# connections" />,
            to: '/admin/thunderbolt/mcp',
          },
          {
            label: t`Models`,
            summary: <Plural value={models} one="# model" other="# models" />,
            to: '/admin/thunderbolt/models',
          },
        ]}
      />
    </DetailPanel>
  )
}
