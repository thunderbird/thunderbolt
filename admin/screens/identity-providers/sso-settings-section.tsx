/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { DetailDivider } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { TriangleAlert } from 'lucide-react'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AdminConnectionDetail, SsoProtocol } from '@shared/admin-api'
import { describeConnection } from './connection-status'
import { describedBy, FormField } from '../../components/form-field'
import { ReadOnlyField } from './form-field'
import { oidcRedirectUri, samlAcsUrl, samlMetadataUrl } from './setup-urls'
import { SsoConnectionForm } from './sso-connection-form'
import { useSsoSettingsState, type SsoConnectionDetail, type SsoSettingsField } from './use-sso-settings-state'
import { CopyableField } from '../../components/copyable-field'
import { InlineError } from '../../components/inline-error'

type SectionProps = { detail: AdminConnectionDetail; onDirty: (dirty: boolean) => void }

/** Whether the connection has an SSO side to edit. */
const hasSso = (detail: AdminConnectionDetail): detail is SsoConnectionDetail => detail.sso !== null

/** The values an admin gives their identity provider for this connection. */
const SetupUrls = ({ detail }: { detail: SsoConnectionDetail }) => {
  const { t } = useLingui()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const { providerId, protocol } = detail.sso
  const urls =
    protocol === 'oidc'
      ? [{ label: t`Redirect URI`, copyLabel: t`Copy redirect URI`, url: oidcRedirectUri(cloudUrl, providerId) }]
      : [
          {
            label: t`Assertion consumer service URL`,
            copyLabel: t`Copy assertion consumer service URL`,
            url: samlAcsUrl(cloudUrl, providerId),
          },
          {
            label: t`Service provider metadata`,
            copyLabel: t`Copy service provider metadata URL`,
            url: samlMetadataUrl(cloudUrl, providerId),
          },
        ]
  return (
    <>
      {urls.map(({ label, copyLabel, url }) => (
        <DetailField key={label} label={label}>
          <CopyableField label={label} copyLabel={copyLabel} value={url} />
        </DetailField>
      ))}
    </>
  )
}

/** A connection's SSO settings, read-only, in groups; an admin-created one edits them in `SsoSettingsForm`. */
const ReadOnlySettings = ({ detail }: { detail: SsoConnectionDetail }) => {
  const { t } = useLingui()
  const { sso } = detail
  const summary = describeConnection(detail)
  return (
    <div className="flex flex-col gap-5">
      <ReadOnlyField label={t`Provider ID`} value={sso.providerId} />
      {sso.protocol === 'oidc' ? (
        <ReadOnlyField label={t`Issuer`} value={sso.issuer} />
      ) : (
        <>
          <ReadOnlyField label={t`Service provider entity ID`} value={sso.entityId} />
          <ReadOnlyField label={t`Identity provider issuer`} value={sso.idpIssuer ?? '—'} />
        </>
      )}
      <DetailDivider />
      {sso.protocol === 'oidc' ? (
        <>
          <ReadOnlyField label={t`Client ID`} value={sso.clientId} />
          {sso.discoveryEndpoint && <ReadOnlyField label={t`Discovery URL`} value={sso.discoveryEndpoint} />}
        </>
      ) : (
        <ReadOnlyField label={t`Sign-in URL`} value={sso.entryPoint} />
      )}
      <ReadOnlyField label={sso.protocol === 'oidc' ? t`Match claim` : t`Match attribute`} value={detail.matchClaim} />
      <DetailDivider />
      <SetupUrls detail={detail} />
      {summary.canEditSso && (summary.scim === 'active' || summary.scim === 'retiring') && (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>To retire this connection, retire its SCIM provisioning first.</Trans>
        </p>
      )}
    </div>
  )
}

type SsoSettingsFormProps = {
  detail: SsoConnectionDetail
  onDirty: (dirty: boolean) => void
  onCancel: () => void
  onSaved: () => void
}

/** The edit form of an admin-created connection's SSO settings. */
export const SsoSettingsForm = ({ detail, onDirty, onCancel, onSaved }: SsoSettingsFormProps) => {
  const { t, i18n } = useLingui()
  const idPrefix = useId()
  const form = useSsoSettingsState({ detail, onDirty, onSaved })
  const { sso } = detail

  const identityLock = t`Locked after the first sign-in.`
  const matchClaimLock = t`Locked after the first sign-in or a link review.`

  /** A form input; a locked one shows the stored value, disabled, with why. */
  const field = (
    name: SsoSettingsField,
    label: string,
    {
      hint,
      tooltip,
      stored,
      type = 'text',
      multiline = false,
    }: {
      hint?: string
      tooltip?: string
      stored?: string
      type?: 'text' | 'url' | 'password'
      multiline?: boolean
    } = {},
  ) => {
    const id = `${idPrefix}-${name}`
    const locked = form.isLocked(name)
    const shownHint = locked ? (name === 'matchClaim' ? matchClaimLock : identityLock) : hint
    const error = form.fieldError?.field === name ? i18n._(form.fieldError.message) : undefined
    const props = {
      id,
      value: locked ? (stored ?? '') : form.draft[name],
      disabled: locked,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy(id, { hint: shownHint, error }),
    }
    return (
      <FormField id={id} label={label} hint={shownHint} tooltip={tooltip} error={error}>
        {multiline ? (
          <Textarea
            {...props}
            rows={5}
            className="font-mono"
            onChange={(event) => form.setField(name, event.target.value)}
          />
        ) : (
          <Input
            {...props}
            type={type}
            autoComplete="off"
            onChange={(event) => form.setField(name, event.target.value)}
          />
        )}
      </FormField>
    )
  }

  const replaceHint = t`Leave blank to keep the current one.`

  return (
    <form className="flex flex-1 flex-col gap-5" onSubmit={form.submit}>
      {field('name', t`Name`)}
      {sso.protocol === 'oidc' ? (
        <>
          {field('clientId', t`Client ID`, { stored: sso.clientId })}
          {field('clientSecret', t`New client secret`, { type: 'password', hint: replaceHint })}
          {field('discoveryEndpoint', t`Discovery URL`, { type: 'url', stored: sso.discoveryEndpoint ?? '' })}
        </>
      ) : (
        <>
          {field('entryPoint', t`Sign-in URL`, { type: 'url', stored: sso.entryPoint })}
          {field('cert', t`New signing certificate`, { multiline: true, hint: replaceHint })}
        </>
      )}
      {field('matchClaim', sso.protocol === 'oidc' ? t`Match claim` : t`Match attribute`, {
        stored: detail.matchClaim,
        tooltip: t`Must hold the person's SCIM externalId.`,
      })}
      <FormFooter>
        <InlineError error={form.formError} className="min-w-0 flex-1 truncate" />
        <ResponsiveModalCancel onClick={onCancel} className="dark:hover:bg-accent" />
        <Button type="submit" disabled={!form.hasChanges} isLoading={form.isPending} loadingLabel={t`Saving…`}>
          <Trans>Save</Trans>
        </Button>
      </FormFooter>
    </form>
  )
}

/** What attaching an SSO side does to the members this connection already provisions. */
const AttachSsoWarning = () => (
  <Alert>
    <TriangleAlert />
    <AlertTitle>
      <Trans>Sign-in becomes SSO-only</Trans>
    </AlertTitle>
    <AlertDescription>
      <Trans>
        People it provisions can no longer sign in with an email code, and each needs a SCIM record before their first
        sign-in.
      </Trans>
    </AlertDescription>
  </Alert>
)

/** A SCIM-only connection: no rename (the API has none for it), but it can take an SSO side. */
const AddSso = ({ detail, onDirty }: SectionProps) => {
  const [protocol, setProtocol] = useState<SsoProtocol | null>(null)
  const { retired } = describeConnection(detail)
  if (protocol) {
    return (
      <div className="flex flex-1 flex-col gap-5">
        <AttachSsoWarning />
        <SsoConnectionForm
          protocol={protocol}
          attachTo={detail}
          onCreated={() => setProtocol(null)}
          onCancel={() => {
            setProtocol(null)
            onDirty(false)
          }}
          onDirty={onDirty}
        />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {!retired && <AttachSsoWarning />}
      {!retired && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setProtocol('oidc')}>
            <Trans>Add OIDC sign-in</Trans>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setProtocol('saml')}>
            <Trans>Add SAML sign-in</Trans>
          </Button>
        </div>
      )}
    </div>
  )
}

/** The Sign-in tab of a connection's view: its SSO settings, or adding an SSO side to a SCIM-only one. */
export const SsoSettingsSection = ({ detail, onDirty }: SectionProps) =>
  hasSso(detail) ? <ReadOnlySettings detail={detail} /> : <AddSso detail={detail} onDirty={onDirty} />
