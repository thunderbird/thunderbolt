/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { BreakGlassWarning } from '@shared/admin-api'
import { cn } from '@/lib/utils'

/** Whether a role change left no admin who can sign in without the identity provider. */
export const hasBreakGlassWarning = (response: BreakGlassWarning | undefined): boolean =>
  response?.warning === 'NO_LOCAL_ADMIN'

/** Shown after a role change that left every admin depending on the identity provider to sign in. */
export const BreakGlassBanner = ({ className }: { className?: string }) => (
  <Alert variant="destructive" className={cn(className)}>
    <TriangleAlert />
    <AlertTitle>
      <Trans>No admin can sign in without your identity provider</Trans>
    </AlertTitle>
    <AlertDescription>
      <p>
        <Trans>
          If the identity provider goes down, nobody can administer this organization. Give admin to someone who signs
          in by email code.
        </Trans>
      </p>
      <Link to="/admin/break-glass" className="font-medium underline underline-offset-4">
        <Trans>Review break-glass access</Trans>
      </Link>
    </AlertDescription>
  </Alert>
)
