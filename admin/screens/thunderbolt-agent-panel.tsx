/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useSearchParams } from 'react-router'
import { getProviderDisplay } from '@/settings/models/model-presentation'
import { cleanServerUrl } from '@/settings/connections/display'
import { AppLogo } from '@/components/app-logo'
import { DetailPanel } from '@/components/detail-panel'
import { IconTile } from '@/components/settings/icon-tile'
import { builtInAgent } from '@/defaults/agents'
import type { AdminPreview } from '../use-admin-preview-state'
import { ThunderboltResourceSummary } from './thunderbolt-resource-summary'
import { PanelSections } from './panel-sections'

export const ThunderboltAgentPanel = ({ preview, onClose }: { preview: AdminPreview; onClose: () => void }) => {
  const { t, i18n } = useLingui()
  const [params, setParams] = useSearchParams()
  const section = params.get('tab') === 'models' ? 'models' : params.get('tab') === 'mcp' ? 'mcp' : 'skills'
  const setSection = (tab: string) =>
    setParams(
      (current) => {
        current.set('tab', tab)
        return current
      },
      { replace: true },
    )
  return (
    <DetailPanel
      title={builtInAgent.name}
      subtitle={t`Built-in · Everyone`}
      onClose={onClose}
      icon={
        <IconTile>
          <AppLogo className="size-5" />
        </IconTile>
      }
    >
      <PanelSections
        label={t`Thunderbolt settings`}
        sections={[
          { id: 'skills', label: t`Skills` },
          { id: 'models', label: t`Models` },
          { id: 'mcp', label: t`Connections` },
        ]}
        value={section}
        onChange={setSection}
      />
      {section === 'skills' && (
        <ThunderboltResourceSummary
          items={preview.companySkills.map((skill) => ({ ...skill, name: skill.label }))}
          path="/admin/thunderbolt/skills"
          manageLabel={t`Manage skills`}
          description={<Trans>Skills the built-in Thunderbolt agent can use for everyone in your company.</Trans>}
          empty={<Trans>No company skills yet.</Trans>}
        />
      )}
      {section === 'mcp' && (
        <ThunderboltResourceSummary
          items={preview.companyMcpServers.map((server) => ({
            id: server.id,
            name: server.name,
            description: cleanServerUrl(server.url),
            enabled: server.enabled === 1,
          }))}
          path="/admin/thunderbolt/mcp"
          manageLabel={t`Manage connections`}
          description={<Trans>Connections available to the company's Thunderbolt agent.</Trans>}
          empty={<Trans>No company connections yet.</Trans>}
        />
      )}

      {section === 'models' && (
        <>
          <ThunderboltResourceSummary
            items={preview.companyModels.map((model) => ({
              id: model.id,
              name: model.name,
              description: `${getProviderDisplay(i18n, { ...model, isSystem: 0 })} · ${model.model}`,
              enabled: model.enabled === 1,
            }))}
            path="/admin/thunderbolt/models"
            manageLabel={t`Manage models`}
            description={<Trans>Models available to the company's Thunderbolt agent.</Trans>}
            empty={<Trans>No company models yet.</Trans>}
          />
        </>
      )}
    </DetailPanel>
  )
}
