/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LoaderCircle, Shield, ShieldAlert } from 'lucide-react'
import { GradientShieldCheck } from '@/components/ui/gradient-shield-check'
import type { AttestationState } from '@/attestation/types'
import { cn } from '@/lib/utils'

export const AttestationStatusIcon = ({
  status,
  className,
}: {
  status: AttestationState['status']
  className?: string
}) => {
  if (status === 'verified') {
    return <GradientShieldCheck className={className} />
  }
  const Icon = status === 'verifying' ? LoaderCircle : status === 'failed' ? ShieldAlert : Shield
  return (
    <Icon
      aria-hidden="true"
      className={cn(className, 'text-muted-foreground', status === 'verifying' && 'motion-safe:animate-spin')}
    />
  )
}
