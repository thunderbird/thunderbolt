/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { AgentGlyph } from '@/components/agent-glyph'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types/acp'
import { AgentListRow } from './agent-list-row'
import { agentProvenanceLine } from './agent-provenance'
import { Switch } from '@/components/ui/switch'

type AgentRowProps = {
  agent: Agent
  /** Whether this row's detail panel is open — brightens the row like other
   *  selected list items across the app. */
  isSelected?: boolean
  /** Opens the configuration aside. */
  onOpen: (agent: Agent) => void
  onToggle?: (enabled: boolean) => void
  togglePending?: boolean
}

/** Agent row with a separate activation control for editable agents. */
export const AgentRow = ({ agent, isSelected, onOpen, onToggle, togglePending }: AgentRowProps) => {
  const { t } = useLingui()
  const disabled = agent.enabled !== 1

  return (
    <AgentListRow
      testId={`agent-row-${agent.id}`}
      isSelected={isSelected}
      onOpen={() => onOpen(agent)}
      ariaLabel={t`Open ${agent.name}`}
      trailing={
        onToggle && (
          <Switch
            checked={!disabled}
            disabled={togglePending}
            onCheckedChange={onToggle}
            aria-label={disabled ? t`Enable ${agent.name}` : t`Disable ${agent.name}`}
          />
        )
      }
      isDimmed={disabled}
      icon={
        // The logo reads slightly smaller than the lucide glyphs at equal
        // box size, so it gets a half-step bump.
        <AgentGlyph
          agent={agent}
          className={cn('text-muted-foreground', agent.type === 'built-in' ? 'size-5.5' : 'size-5')}
          aria-hidden="true"
        />
      }
      title={agent.name}
      subtitleTestId={`agent-provenance-${agent.id}`}
      subtitle={
        <>
          {agentProvenanceLine(agent)}
          {disabled && <> · {t`Disabled`}</>}
        </>
      }
      chevronTestId={`agent-chevron-${agent.id}`}
    />
  )
}
