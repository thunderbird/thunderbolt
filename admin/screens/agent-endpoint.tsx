/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans } from '@lingui/react/macro'
import { useState } from 'react'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { originalAgentFixtures, flakyAcpUrl } from '../original-agent-fixtures'

/** Endpoint responses mirror the source demo fixtures, only for its known endpoints. Never probes the network. */
export const AgentEndpoint = ({ acpUrl }: { acpUrl: string }) => {
  const [tested, setTested] = useState(false)
  const source = originalAgentFixtures.find((agent) => agent.acpUrl === acpUrl)
  const isFailure = acpUrl === flakyAcpUrl
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
    </>
  )
}
