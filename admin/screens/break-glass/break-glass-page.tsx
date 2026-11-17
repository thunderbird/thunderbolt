/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { isSsoMode } from '@/lib/auth-mode'
import { isTauri } from '@/lib/platform'
import type { BreakGlassStatus } from '@shared/admin-api'
import { getAdminErrorMessage } from '../../api/error-messages'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { AdminPage } from '../../components/admin-page'
import { ListSkeleton } from '../../components/list-skeleton'
import { EmailCodeSignIn } from './email-code-sign-in'

const StatusAlert = ({ status }: { status: BreakGlassStatus }) => {
  const { adminCount, localAdminCount } = status
  if (status.allAdminsIdpManaged) {
    return (
      <Alert variant="destructive">
        <ShieldAlert />
        <AlertTitle>
          <Trans>No admin can sign in without your identity provider</Trans>
        </AlertTitle>
        <AlertDescription>
          <p>
            <Trans>
              Every admin signs in through an identity provider. If it goes down, no one can administer this
              organization. Give the admin role to a member no identity provider manages, from{' '}
              <Link to="/admin/members" className="underline">
                Members
              </Link>
              .
            </Trans>
          </p>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert>
      <ShieldCheck />
      <AlertTitle>
        <Plural
          value={localAdminCount}
          one="# admin can sign in without your identity provider"
          other="# admins can sign in without your identity provider"
        />
      </AlertTitle>
      <AlertDescription>
        <p>
          <Plural value={adminCount} one="This organization has # admin." other="This organization has # admins." />{' '}
          <Trans>Those who sign in with an email code can still administer it if your identity provider is down.</Trans>
        </p>
      </AlertDescription>
    </Alert>
  )
}

/** Whether an admin can still sign in while the identity provider is down. */
export const BreakGlassPage = () => {
  const { t, i18n } = useLingui()
  const api = useAdminApi()
  const status = useQuery({ queryKey: adminQueryKeys.breakGlass, queryFn: api.breakGlass.get })

  const body = () => {
    if (status.isPending) {
      return <ListSkeleton rows={2} />
    }
    if (status.isError) {
      return (
        <Alert variant="destructive">
          <AlertDescription>{i18n._(getAdminErrorMessage(status.error))}</AlertDescription>
        </Alert>
      )
    }
    return <StatusAlert status={status.data} />
  }

  return (
    <AdminPage title={t`Break-glass`}>
      {body()}
      <section className="flex flex-col gap-2 rounded-xl border p-4">
        <h2 className="font-medium">
          <Trans>Email-code sign-in</Trans>
        </h2>
        {/* The desktop app's origin is a tauri:// URL, which is no use to a browser. */}
        <EmailCodeSignIn origin={isTauri() ? null : window.location.origin} ssoMode={isSsoMode()} />
      </section>
    </AdminPage>
  )
}
