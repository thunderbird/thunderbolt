/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DetailDivider } from '@/components/detail-panel'
import { CopyCommandRow } from '@/components/settings/copy-command-row'
import { DetailField } from '@/components/settings/detail-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { useFormatters } from '@/i18n/use-formatters'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AdminConnectionDetail, ScimCredential } from '@shared/admin-api'
import { CopyOnceSecret } from '../../components/copy-once-secret'
import { InlineError } from '../../components/inline-error'
import { describeConnection } from './connection-status'
import { ExpiryField } from './expiry-field'
import { ScimCredentialList, shortCredentialId } from './scim-credential-list'
import { scimBaseUrl } from './setup-urls'
import { useScimSectionState } from './use-scim-section-state'

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
      secret={token}
      details={[
        { label: t`SCIM base URL`, value: scimBaseUrl(cloudUrl) },
        { label: t`Expires`, value: formatters.date(credential.expiresAt) },
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
  onDirty: (dirty: boolean) => void
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
          <p className="text-muted-foreground">
            <Trans>This connection can't take SCIM provisioning.</Trans>
          </p>
        )
      }
      return (
        <>
          <p className="text-muted-foreground">
            <Trans>With SCIM, your identity provider creates, updates and removes people in Thunderbolt.</Trans>
          </p>
          {detail.sso && (
            <Alert>
              <AlertDescription>
                <Trans>
                  Turning on SCIM makes sign-in through this connection SSO-only, and a person needs a SCIM record
                  before their first sign-in: your identity provider has to provision them first.
                </Trans>
              </AlertDescription>
            </Alert>
          )}
          <ExpiryField value={scim.expiry} onChange={scim.setExpiry} />
          <InlineError error={scim.issueError} />
          <div>
            <Button type="button" disabled={!scim.canIssue} isLoading={scim.isIssuing} onClick={scim.enable}>
              <Trans>Turn on SCIM</Trans>
            </Button>
          </div>
        </>
      )
    }
    if (summary.scim === 'retiring') {
      return (
        <>
          <p role="status" className="text-muted-foreground">
            <Trans>
              Retiring SCIM provisioning. Its tokens no longer work, and the cleanup of its people and groups runs in
              the background.
            </Trans>
          </p>
          <ScimCredentialList credentials={detail.scimCredentials} />
        </>
      )
    }
    if (summary.scim === 'retired') {
      return (
        <>
          <p role="status" className="text-muted-foreground">
            <Trans>SCIM provisioning is retired.</Trans>
          </p>
          <ScimCredentialList credentials={detail.scimCredentials} />
        </>
      )
    }
    return (
      <>
        <DetailField label={<Trans>SCIM base URL</Trans>}>
          <CopyCommandRow command={scimBaseUrl(cloudUrl)} label={t`Copy SCIM base URL`} />
        </DetailField>
        <DetailField label={<Trans>Credentials</Trans>}>
          <ScimCredentialList credentials={detail.scimCredentials} onRevoke={scim.requestRevoke} />
        </DetailField>
        <DetailDivider />
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>
            A new credential leaves the current ones working until you revoke them, so you can switch your identity
            provider over without a gap.
          </Trans>
        </p>
        <ExpiryField value={scim.expiry} onChange={scim.setExpiry} />
        <InlineError error={scim.issueError} />
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!scim.canIssue}
            isLoading={scim.isIssuing}
            onClick={scim.rotate}
          >
            <Trans>Issue a new credential</Trans>
          </Button>
          <Button type="button" variant="destructive" onClick={scim.requestRetire}>
            <Trans>Retire SCIM</Trans>
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
        confirmLabel={t`Revoke`}
        isPending={scim.isRevoking}
        onCancel={scim.cancelRevoke}
        onConfirm={scim.confirmRevoke}
      />
      <ConfirmActionDialog
        open={scim.confirmingRetire}
        title={t`Retire SCIM provisioning?`}
        description={
          <>
            <Trans>
              Its tokens stop working at once, and people lose the access it gave them. Cleanup runs in the background.
              This can't be undone.
            </Trans>
            <InlineError error={scim.retireError} />
          </>
        }
        confirmLabel={t`Retire SCIM`}
        isPending={scim.isRetiring}
        onCancel={scim.cancelRetire}
        onConfirm={scim.confirmRetire}
      />
    </div>
  )
}
