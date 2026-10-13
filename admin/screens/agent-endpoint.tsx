/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans } from '@lingui/react/macro'
import { useState } from 'react'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { originalAgentFixtures, flakyAcpUrl } from '../original-agent-fixtures'
import { AgentTags } from './agent-preview'

/** Endpoint responses mirror the source demo fixtures, only for its known endpoints. Never probes the network. */
export const AgentEndpoint = ({ acpUrl }: { acpUrl: string }) => {
  const [tested, setTested] = useState(false)
  const source = originalAgentFixtures.find((agent) => agent.acpUrl === acpUrl)
  const isFailure = acpUrl === flakyAcpUrl
  const seed = acpUrl.split('/').filter(Boolean).pop() ?? ''
  return (
    <>
      <DetailField label={<Trans>From ACP server</Trans>}>
        <p className="text-sm text-muted-foreground">
          <Trans>Recorded sample responses from the original design. No connection is made.</Trans>
        </p>
      </DetailField>
      <DetailField label={<Trans>Status</Trans>}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={isFailure && tested ? 'text-destructive' : 'text-muted-foreground'} role="status">
            {!tested ? (
              <Trans>Not tested</Trans>
            ) : !source ? (
              <Trans>No sample response for this endpoint</Trans>
            ) : isFailure ? (
              <Trans>Sample connection refused</Trans>
            ) : (
              <Trans>Sample connection successful</Trans>
            )}
          </span>
          <Button variant="secondary" onClick={() => setTested(true)}>
            <Trans>Test connection</Trans>
          </Button>
        </div>
        {isFailure && (
          <p className="text-sm text-destructive">
            <Plural value={3} one="# user failure in the sample" other="# user failures in the sample" />
          </p>
        )}
      </DetailField>
      {source && !isFailure && (
        <>
          <DetailField label={<Trans>Models</Trans>}>
            <AgentTags items={['claude-opus-4-8', 'claude-haiku-4-5']} />
          </DetailField>
          <DetailField label={<Trans>MCP servers</Trans>}>
            <AgentTags items={[`${seed}-mcp`, 'shared-knowledge-mcp']} />
          </DetailField>
          <DetailField label={<Trans>Tools</Trans>}>
            <AgentTags items={[`search_${seed}`, `summarize_${seed}`, 'create_note']} />
          </DetailField>
        </>
      )}
    </>
  )
}
