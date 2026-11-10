/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { AttestationDetails } from './attestation-details'
import { useAttestationDisplay } from './use-attestation-display'
import type { AttestationControlProps } from './props'

export const AttestationPanel = ({ target, state, onVerify, hour12 }: AttestationControlProps) => {
  const { status, description } = useAttestationDisplay(target, state)
  return (
    <div className="min-h-0 overflow-y-auto space-y-4">
      <p className="text-[length:var(--font-size-sm)] leading-relaxed text-muted-foreground">{description}</p>
      {target.kind === 'local' && state.status === 'verified' && (
        <AttestationDetails evidence={state.evidence} hour12={hour12} />
      )}
      {target.kind === 'local' && (status === 'idle' || status === 'failed') && (
        <Button type="button" variant="outline" size="sm" onClick={onVerify} className="w-full">
          {status === 'failed' ? <Trans>Try again</Trans> : <Trans>Verify connection</Trans>}
        </Button>
      )}
      <p className="text-[length:var(--font-size-xs)] leading-relaxed text-muted-foreground">
        {target.kind === 'agent' ? (
          <Trans>An encrypted agent connection alone does not verify the agent or its model provider.</Trans>
        ) : (
          <Trans>
            Verification covers model inference. Connected tools and external services have their own privacy
            boundaries.
          </Trans>
        )}
      </p>
    </div>
  )
}
