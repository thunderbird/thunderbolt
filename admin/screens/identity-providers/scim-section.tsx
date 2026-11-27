/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DetailDivider } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { useFormatters } from '@/i18n/use-formatters'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AdminConnectionDetail, ScimCredential } from '@shared/admin-api'
import { TriangleAlert } from 'lucide-react'
import { CopyableField } from '../../components/copyable-field'
import { CopyOnceSecret } from '../../components/copy-once-secret'
import { InlineError } from '../../components/inline-error'
import { describeConnection } from './connection-status'
import { ExpiryField } from './expiry-field'
import { ScimCredentialList, shortCredentialId } from './scim-credential-list'
import { scimBaseUrl } from './setup-urls'
import { useScimSectionState } from './use-scim-section-state'
import type { PanelDirt } from '../../components/use-resource-page-state'

/** A token just issued, with what to paste beside it. Shown once. */
export const IssuedScimToken = ({
  credential,
  token,
  onDone,
}: {
  credential: ScimCredential
  token: string
  onDone: () => void
}) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  return (
    <CopyOnceSecret
      label={t`SCIM token`}
      copyLabel={t`Copy SCIM token`}
      secret={token}
      details={[
        { label: t`SCIM base URL`, copyLabel: t`Copy SCIM base URL`, value: scimBaseUrl(cloudUrl) },
        { label: t`Expires`, copyLabel: t`Copy expiry date`, value: formatters.date(credential.expiresAt) },
      ]}
      onDone={onDone}
    />
  )
}

/** The Provisioning tab: a connection's SCIM side, its credentials, and retiring it. */
export const ScimSection = ({
  detail,
  onDirty,
}: {
  detail: AdminConnectionDetail
  onDirty: (dirty: PanelDirt) => void
}) => {
  const { t } = useLingui()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const scim = useScimSectionState(detail, onDirty)
  const summary = describeConnection(detail)
  const revokingId = scim.revokeId ? shortCredentialId(scim.revokeId) : ''

  const body = () => {
    if (summary.scim === null) {
      if (!summary.canAddScim) {
        return (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>This connection can't take SCIM provisioning.</Trans>
          </p>
        )
      }
      return (
        <>
          {detail.sso && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>
                <Trans>Sign-in becomes SSO-only</Trans>
              </AlertTitle>
              <AlertDescription>
                <Trans>Each person needs a SCIM record before their first sign-in.</Trans>
              </AlertDescription>
            </Alert>
          )}
          <ExpiryField value={scim.expiry} onChange={scim.setExpiry} />
          <InlineError error={scim.issueError} />
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!scim.canIssue}
              isLoading={scim.isIssuing}
              onClick={scim.enable}
            >
              <Trans>Turn on SCIM</Trans>
            </Button>
          </div>
        </>
      )
    }
    if (summary.scim === 'retiring') {
      return (
        <>
          <p role="status" className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Retiring. Tokens no longer work; cleanup runs in the background.</Trans>
          </p>
          <ScimCredentialList credentials={detail.scimCredentials} />
        </>
      )
    }
    if (summary.scim === 'retired') {
      return (
        <>
          <p role="status" className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>SCIM provisioning is retired.</Trans>
          </p>
          <ScimCredentialList credentials={detail.scimCredentials} />
        </>
      )
    }
    return (
      <>
        {/* An issued token's card already shows the base URL beside it. */}
        {!scim.issued && (
          <DetailField label={<Trans>SCIM base URL</Trans>} className="gap-2">
            <CopyableField label={t`SCIM base URL`} copyLabel={t`Copy SCIM base URL`} value={scimBaseUrl(cloudUrl)} />
          </DetailField>
        )}
        <DetailField label={<Trans>Credentials</Trans>} className="gap-2">
          <ScimCredentialList credentials={detail.scimCredentials} onRevoke={scim.requestRevoke} />
        </DetailField>
        <DetailDivider />
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Current credentials keep working until you revoke them.</Trans>
        </p>
        <ExpiryField value={scim.expiry} onChange={scim.setExpiry} />
        <InlineError error={scim.issueError} />
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!scim.canIssue}
            isLoading={scim.isIssuing}
            onClick={scim.rotate}
          >
            <Trans>Issue a new credential</Trans>
          </Button>
        </div>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {scim.issued && (
        <IssuedScimToken credential={scim.issued.credential} token={scim.issued.token} onDone={scim.dismissIssued} />
      )}
      {body()}
      <ConfirmActionDialog
        open={scim.revokeId !== null}
        title={t`Revoke credential ${revokingId}?`}
        description={
          <>
            <Trans>Its token stops working at once.</Trans>
            <InlineError error={scim.revokeError} />
          </>
        }
        confirmLabel={t`Revoke credential`}
        isPending={scim.isRevoking}
        onCancel={scim.cancelRevoke}
        onConfirm={scim.confirmRevoke}
      />
    </div>
  )
}
