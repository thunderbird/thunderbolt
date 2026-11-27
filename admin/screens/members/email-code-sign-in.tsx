/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ssoEmailCodePath } from '@/lib/sso-paths'
import { CopyableField } from '../../components/copyable-field'

type EmailCodeSignInProps = {
  /** The web app's origin, or null where there's none to give (the desktop app). */
  origin: string | null
  /** SSO deployments keep email code on its own page; elsewhere the sign-in page itself asks for one. */
  ssoMode: boolean
}

/** Where a break-glass admin signs in by email code: the address to copy, or just the path without an `origin`. */
export const EmailCodeSignIn = ({ origin, ssoMode }: EmailCodeSignInProps) => {
  const { t } = useLingui()
  const path = ssoMode ? ssoEmailCodePath : '/'
  const url = origin && origin + path

  return (
    <>
      {ssoMode && (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Keep this address somewhere that doesn't depend on your identity provider.</Trans>
        </p>
      )}
      {url ? (
        <CopyableField label={t`Email-code sign-in address`} copyLabel={t`Copy the sign-in address`} value={url} />
      ) : (
        <p className="text-[length:var(--font-size-sm)]">
          <Trans>
            Open <code>{path}</code> on your organization's web app.
          </Trans>
        </p>
      )}
    </>
  )
}
