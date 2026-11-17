/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { ssoEmailCodePath } from '@/lib/sso-paths'

type EmailCodeSignInProps = {
  /** The web app's origin, or null where there's none to give (the desktop app). */
  origin: string | null
  /** SSO deployments keep email code on its own page; elsewhere the sign-in page itself asks for one. */
  ssoMode: boolean
}

/** Where a break-glass admin signs in by email code: the address to copy, or just the path without an `origin`. */
export const EmailCodeSignIn = ({ origin, ssoMode }: EmailCodeSignInProps) => {
  const { t } = useLingui()
  const { copy, isCopied } = useCopyToClipboard()
  const path = ssoMode ? ssoEmailCodePath : '/'
  const url = origin && origin + path

  return (
    <>
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        {ssoMode ? (
          <Trans>
            A local admin signs in here when the identity provider is down. With one identity provider the sign-in
            screen goes straight to it, so keep this address somewhere that doesn't depend on it.
          </Trans>
        ) : (
          <Trans>Every admin signs in with an email code from the app's sign-in page.</Trans>
        )}
      </p>
      {url ? (
        <div className="flex items-center gap-2">
          <Input readOnly aria-label={t`Email-code sign-in address`} value={url} className="min-w-0 flex-1 font-mono" />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t`Copy the sign-in address`}
            onClick={() => void copy(url)}
          >
            {isCopied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
          </Button>
        </div>
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
