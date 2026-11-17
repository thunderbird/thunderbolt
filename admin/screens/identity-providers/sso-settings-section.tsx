/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { DetailDivider } from '@/components/detail-panel'
import { CopyCommandRow } from '@/components/settings/copy-command-row'
import { DetailField } from '@/components/settings/detail-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AdminConnectionDetail, SsoProtocol } from '@shared/admin-api'
import { getAdminErrorMessage } from '../../api/error-messages'
import { describeConnection } from './connection-status'
import { describedBy, FormField, ReadOnlyField } from './form-field'
import { oidcRedirectUri, samlAcsUrl, samlMetadataUrl } from './setup-urls'
import { SsoConnectionForm } from './sso-connection-form'
import { useSsoSettingsState, type SsoConnectionDetail, type SsoSettingsField } from './use-sso-settings-state'

type SectionProps = { detail: AdminConnectionDetail; onDirty: (dirty: boolean) => void }

const hasSso = (detail: AdminConnectionDetail): detail is SsoConnectionDetail => detail.sso !== null

/** The values an admin gives their identity provider for this connection. */
const SetupUrls = ({ detail }: { detail: SsoConnectionDetail }) => {
  const { t } = useLingui()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const { providerId, protocol } = detail.sso
  const urls =
    protocol === 'oidc'
      ? [{ label: t`Redirect URI`, url: oidcRedirectUri(cloudUrl, providerId) }]
      : [
          { label: t`Assertion consumer service URL`, url: samlAcsUrl(cloudUrl, providerId) },
          { label: t`Service provider metadata`, url: samlMetadataUrl(cloudUrl, providerId) },
        ]
  return (
    <>
      {urls.map(({ label, url }) => (
        <DetailField key={label} label={label}>
          <CopyCommandRow command={url} label={t`Copy ${label}`} />
        </DetailField>
      ))}
    </>
  )
}

/** The fields that name the provider, shown and never edited. */
const IdentityFields = ({ detail }: { detail: SsoConnectionDetail }) => {
  const { t } = useLingui()
  const { sso } = detail
  const hint = t`This identifies the provider and can't change. To use a different one, retire this connection and add another.`
  return (
    <>
      <ReadOnlyField label={t`Provider ID`} value={sso.providerId} />
      {sso.protocol === 'oidc' ? (
        <ReadOnlyField label={t`Issuer`} value={sso.issuer} hint={hint} />
      ) : (
        <>
          <ReadOnlyField label={t`Service provider entity ID`} value={sso.entityId} />
          <ReadOnlyField label={t`Identity provider issuer`} value={sso.idpIssuer ?? '—'} hint={hint} />
        </>
      )}
    </>
  )
}

/** The env connection, or a retired one: everything shown, nothing editable. */
const ReadOnlySettings = ({ detail }: { detail: SsoConnectionDetail }) => {
  const { t } = useLingui()
  const { sso } = detail
  return (
    <div className="flex flex-col gap-5">
      {sso.envOwned && (
        <Alert>
          <AlertDescription>
            <Trans>Set by this server's OIDC or SAML settings. Change them there.</Trans>
          </AlertDescription>
        </Alert>
      )}
      <IdentityFields detail={detail} />
      {sso.protocol === 'oidc' ? (
        <>
          <ReadOnlyField label={t`Client ID`} value={sso.clientId} />
          {sso.discoveryEndpoint && <ReadOnlyField label={t`Discovery URL`} value={sso.discoveryEndpoint} />}
        </>
      ) : (
        <ReadOnlyField label={t`Sign-in URL`} value={sso.entryPoint} />
      )}
      <ReadOnlyField label={sso.protocol === 'oidc' ? t`Match claim` : t`Match attribute`} value={detail.matchClaim} />
      <SetupUrls detail={detail} />
    </div>
  )
}

/** The editable SSO settings of a connection an admin created. */
const SsoSettingsForm = ({ detail, onDirty }: { detail: SsoConnectionDetail; onDirty: (dirty: boolean) => void }) => {
  const { t, i18n } = useLingui()
  const idPrefix = useId()
  const form = useSsoSettingsState({ detail, onDirty })
  const { sso } = detail
  const summary = describeConnection(detail)

  const identityLock = t`Locked because people have signed in through this connection. It decides which account a sign-in belongs to.`
  const matchClaimLock = t`Locked because people have signed in through this connection, or link reviews for it are pending or approved.`
  const lockable = t`Can change only until someone signs in through this connection.`

  /** A form input; a locked one shows the stored value read-only, with why. */
  const field = (
    name: SsoSettingsField,
    label: string,
    {
      hint,
      stored,
      type = 'text',
      multiline = false,
    }: { hint?: string; stored?: string; type?: 'text' | 'url' | 'password'; multiline?: boolean } = {},
  ) => {
    const id = `${idPrefix}-${name}`
    const locked = form.isLocked(name)
    const shownHint = locked ? (name === 'matchClaim' ? matchClaimLock : identityLock) : hint
    const error = form.fieldError?.field === name ? i18n._(form.fieldError.message) : undefined
    const props = {
      id,
      value: locked ? (stored ?? '') : form.draft[name],
      readOnly: locked,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy(id, { hint: shownHint, error }),
    }
    return (
      <FormField id={id} label={label} hint={shownHint} error={error}>
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

  const replaceHint = t`Leave blank to keep the current one. A new one takes effect at the next sign-in, and nobody needs to link again.`

  return (
    <form className="flex flex-1 flex-col gap-5" onSubmit={form.submit}>
      {field('name', t`Name`, { hint: t`Shown on the sign-in screen.` })}
      <IdentityFields detail={detail} />
      {sso.protocol === 'oidc' ? (
        <>
          {field('clientId', t`Client ID`, { stored: sso.clientId, hint: lockable })}
          {field('clientSecret', t`New client secret`, { type: 'password', hint: replaceHint })}
          {field('discoveryEndpoint', t`Discovery URL`, {
            type: 'url',
            stored: sso.discoveryEndpoint ?? '',
            hint: lockable,
          })}
        </>
      ) : (
        <>
          {field('entryPoint', t`Sign-in URL`, { type: 'url', stored: sso.entryPoint, hint: lockable })}
          {field('cert', t`New signing certificate`, { multiline: true, hint: replaceHint })}
        </>
      )}
      {field('matchClaim', sso.protocol === 'oidc' ? t`Match claim` : t`Match attribute`, {
        stored: detail.matchClaim,
        hint: t`Its value must be the person's SCIM externalId. It can change only until someone signs in through this connection.`,
      })}
      <DetailDivider />
      <SetupUrls detail={detail} />
      {summary.scim === 'active' || summary.scim === 'retiring' ? (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>To retire this connection, retire its SCIM provisioning first.</Trans>
        </p>
      ) : null}
      {form.formError && (
        <p role="alert" className="text-destructive">
          {i18n._(getAdminErrorMessage(form.formError))}
        </p>
      )}
      {form.isSaved && !form.hasChanges && (
        <p role="status" className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Saved.</Trans>
        </p>
      )}
      <FormFooter>
        <Button type="submit" disabled={!form.hasChanges} isLoading={form.isPending}>
          <Trans>Save changes</Trans>
        </Button>
      </FormFooter>
    </form>
  )
}

/** A SCIM-only connection: no rename (the API has none for it), but it can take an SSO side. */
/** What attaching an SSO side does to the members this connection already provisions. */
const AttachSsoWarning = () => (
  <Alert>
    <AlertDescription>
      <Trans>
        Adding sign-in makes this connection SSO-only: the people it provisions can no longer sign in with an email
        code, and a person needs a SCIM record before their first sign-in.
      </Trans>
    </AlertDescription>
  </Alert>
)

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
      <p className="text-muted-foreground">
        <Trans>People can't sign in through this connection: it only provisions them.</Trans>
      </p>
      {!retired && <AttachSsoWarning />}
      {!retired && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setProtocol('oidc')}>
            <Trans>Add OIDC sign-in</Trans>
          </Button>
          <Button type="button" variant="outline" onClick={() => setProtocol('saml')}>
            <Trans>Add SAML sign-in</Trans>
          </Button>
        </div>
      )}
    </div>
  )
}

/** The Sign-in tab: a connection's SSO side, read-only where the server owns or locks it. */
export const SsoSettingsSection = ({ detail, onDirty }: SectionProps) => {
  if (!hasSso(detail)) {
    return <AddSso detail={detail} onDirty={onDirty} />
  }
  if (!describeConnection(detail).canEditSso) {
    return <ReadOnlySettings detail={detail} />
  }
  return <SsoSettingsForm detail={detail} onDirty={onDirty} />
}
