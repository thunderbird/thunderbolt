/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans } from '@lingui/react/macro'
import { DetailDivider } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import type { PreviewAgent } from '../data'
import { AgentEndpoint } from './agent-endpoint'
import { AgentTags } from './agent-tags'

/** Read-only resources advertised by the saved agent, with local fixture connection status. */
export const AgentCapabilities = ({ agent }: { agent: PreviewAgent }) => (
  <>
    <DetailField label={<Trans>Models</Trans>}>
      <AgentTags items={agent.advertisedModels} />
    </DetailField>
    <DetailField label={<Trans>Integrations</Trans>}>
      <AgentTags items={agent.integrations} />
    </DetailField>
    <DetailField label={<Trans>Connections</Trans>}>
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
    <DetailField label={<Trans>Tools</Trans>}>
      <AgentTags items={agent.toolKinds} />
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
    <DetailDivider />
    <AgentEndpoint key={agent.acpUrl} acpUrl={agent.acpUrl} />
  </>
)
