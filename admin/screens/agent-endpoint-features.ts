/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { createCompanyAgent, type PreviewAgent } from '../data'
import { originalAgentFixtures } from '../original-agent-fixtures'

type EndpointFeatures = Pick<
  PreviewAgent,
  | 'advertisedModels'
  | 'integrations'
  | 'mcpKinds'
  | 'toolKinds'
  | 'accepts'
  | 'modes'
  | 'agentSkillCount'
  | 'capabilities'
>

/** Retain advertised features only while the endpoint identity stays the same. */
export const agentEndpointFeatures = (url: string, previous?: PreviewAgent): EndpointFeatures => {
  const source =
    previous?.acpUrl === url
      ? previous
      : (originalAgentFixtures.find((item) => item.acpUrl === url) ?? createCompanyAgent())
  return {
    advertisedModels: source.advertisedModels,
    integrations: source.integrations,
    mcpKinds: source.mcpKinds,
    toolKinds: source.toolKinds,
    accepts: source.accepts,
    modes: source.modes,
    agentSkillCount: source.agentSkillCount,
    capabilities: source.capabilities,
  }
}
