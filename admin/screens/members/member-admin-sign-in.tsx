/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { isSsoMode } from '@/lib/auth-mode'
import { isTauri } from '@/lib/platform'
import type { AdminMember } from '@shared/admin-api'
import { EmailCodeSignIn } from './email-code-sign-in'
import { canSignInWithoutIdp } from './member-rules'

/** For an admin with access: whether they can still get in when the identity provider is down, and how. */
export const MemberAdminSignIn = ({ member }: { member: AdminMember }) => {
  if (canSignInWithoutIdp(member)) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[length:var(--font-size-sm)] font-medium">
          <Trans>Can sign in without your identity provider</Trans>
        </p>
        {/* The desktop app's origin is a tauri:// URL, which is no use to a browser. */}
        <EmailCodeSignIn origin={isTauri() ? null : window.location.origin} ssoMode={isSsoMode()} />
      </div>
    )
  }
  const connections = member.idpManaged?.connections ?? []
  if (!member.access.allowed || connections.length === 0) {
    return null
  }
  const [{ name }] = connections
  return (
    <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
      {connections.length === 1 ? (
        <Trans>Signs in only through {name}. If it goes down, this admin can't get in.</Trans>
      ) : (
        <Trans>Signs in only through your identity providers. If they go down, this admin can't get in.</Trans>
      )}
    </p>
  )
}
