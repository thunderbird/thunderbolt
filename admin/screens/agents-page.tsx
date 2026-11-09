/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { AlertTriangle, Server } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useState } from 'react'
import { SettingsSectionLabel } from '@/components/settings/settings-list'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { AppLogo } from '@/components/app-logo'
import { AgentListRow } from '@/components/settings/agents/agent-list-row'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { builtInAgent } from '@/defaults/agents'
import { PreviewPage } from '../preview-page'
import { flakyAcpUrl } from '../original-agent-fixtures'
import type { AdminPreview } from '../use-admin-preview-state'
import { AgentEditor } from './agent-editor'
import { AgentPolicy } from './agent-policy'
import { ThunderboltAgentPanel } from './thunderbolt-agent-panel'

export const AgentsPage = ({ preview }: { preview: AdminPreview }) => {
  const { t } = useLingui()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const search = query.trim().toLowerCase()
  const matches = preview.agents.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(search))
  const showThunderbolt = preview.state.policy.thunderboltAllowed && builtInAgent.name.toLowerCase().includes(search)
  const selectedId = params.get('agent')
  const setSelectedId = (id: string | null) => setParams(id === null ? {} : { agent: id })
  const agent = preview.agents.find((item) => item.id === selectedId)
  const close = () => setSelectedId(null)
  const thunderboltSelected = selectedId === builtInAgent.id && preview.state.policy.thunderboltAllowed
  return (
    <PreviewPage
      title={t`Agents`}
      actionsClassName="gap-1"
      search={{ label: t`Search agents`, placeholder: t`Search agents`, onSearch: setQuery }}
      onClose={close}
      action={
        <>
          <AgentPolicy preview={preview} />
          <PageCreateAction label={t`Register agent`} onClick={() => setSelectedId('new')} />
        </>
      }
      panel={
        thunderboltSelected ? (
          <ThunderboltAgentPanel preview={preview} onClose={close} />
        ) : (
          (selectedId === 'new' || agent) && (
            <AgentEditor key={selectedId} agent={agent} preview={preview} onClose={close} />
          )
        )
      }
    >
      {showThunderbolt && (
        <AgentListRow
          icon={<AppLogo className="size-5" />}
          title={builtInAgent.name}
          subtitle={t`Built-in · Everyone`}
          isSelected={thunderboltSelected}
          ariaLabel={builtInAgent.name}
          onOpen={() => setSelectedId(thunderboltSelected ? null : builtInAgent.id)}
        />
      )}
      {matches.length > 0 && (
        <SettingsSectionLabel className="mt-4">
          <Trans>Custom agents</Trans>
        </SettingsSectionLabel>
      )}
      {matches.map((item) => {
        const groupNames = preview.groups.filter((group) => item.groupIds.includes(group.id)).map((group) => group.name)
        const access = groupNames.length ? groupNames.join(', ') : t`No groups assigned`
        const category = item.category === 'sealed' ? t`Sealed` : t`Extensible`
        return (
          <AgentListRow
            key={item.id}
            icon={
              item.acpUrl === flakyAcpUrl ? (
                <AlertTriangle
                  className="size-5 text-destructive"
                  aria-label={t`Recent connection failures in the sample`}
                />
              ) : (
                <Server className="size-5 text-muted-foreground" />
              )
            }
            title={item.name}
            subtitle={t`${access} · ${category}`}
            isSelected={selectedId === item.id}
            isDimmed={!item.enabled}
            ariaLabel={item.name}
            onOpen={() => setSelectedId(selectedId === item.id ? null : item.id)}
          />
        )
      })}
      {search && !matches.length && !showThunderbolt && (
        <SettingsNoResults>
          <Trans>No matching agents.</Trans>
        </SettingsNoResults>
      )}
      {!search && !preview.agents.length && !preview.state.policy.thunderboltAllowed && (
        <p className="text-muted-foreground">
          <Trans>No agents registered yet.</Trans>
        </p>
      )}
    </PreviewPage>
  )
}
