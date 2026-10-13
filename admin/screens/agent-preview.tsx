/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans } from '@lingui/react/macro'
import { DetailField } from '@/components/settings/detail-field'
import type { PreviewAgent } from '../data'

export const AgentTags = ({ items }: { items: string[] }) =>
  items.length ? (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-md bg-muted px-2 py-1 text-sm">
          {item}
        </span>
      ))}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">
      <Trans>None</Trans>
    </span>
  )

/** Member-facing content uses the same saved card plus the draft identity, excluding administrative endpoints and raw tool names. */
export const AgentPreview = ({ agent }: { agent: PreviewAgent }) => (
  <>
    <p className="text-sm text-muted-foreground">
      <Trans>This is how the agent appears to your members in the Thunderbolt app.</Trans>
    </p>
    <h3 className="text-lg font-medium">{agent.name}</h3>
    <DetailField label={<Trans>About</Trans>}>
      <p>{agent.description}</p>
    </DetailField>
    <DetailField label={<Trans>Integrations</Trans>}>
      <AgentTags items={agent.integrations} />
    </DetailField>
    <DetailField label={<Trans>MCP</Trans>}>
      <AgentTags items={agent.mcpKinds} />
    </DetailField>
    <DetailField label={<Trans>Skills</Trans>}>
      <p>
        <Plural value={agent.agentSkillCount} one="# bundled skill" other="# bundled skills" />
      </p>
      <p className="text-sm text-muted-foreground">
        {agent.category === 'extensible' ? (
          <Trans>Members’ enabled library skills are available to this agent.</Trans>
        ) : (
          <Trans>Members’ library skills are not shared with this agent.</Trans>
        )}
      </p>
    </DetailField>
    {agent.accepts.length > 0 && (
      <DetailField label={<Trans>Accepts</Trans>}>
        {agent.accepts.includes('images') && (
          <p>
            <Trans>Accepts images</Trans>
          </p>
        )}
        {agent.accepts.includes('audio') && (
          <p>
            <Trans>Accepts audio</Trans>
          </p>
        )}
        {agent.accepts.includes('context') && (
          <p>
            <Trans>Remembers context across a session</Trans>
          </p>
        )}
      </DetailField>
    )}
    <DetailField label={<Trans>Available modes</Trans>}>
      <AgentTags items={agent.modes} />
    </DetailField>
    <DetailField label={<Trans>Models</Trans>}>
      <AgentTags items={agent.advertisedModels} />
    </DetailField>
  </>
)
