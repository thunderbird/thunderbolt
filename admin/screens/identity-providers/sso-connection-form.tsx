/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AdminConnectionDetail, SsoProtocol } from '@shared/admin-api'
import { describedBy, FormField, FormGroup } from '../../components/form-field'
import { providerPresets, type ProviderPreset } from './provider-presets'
import { oidcRedirectUri, samlAcsUrl } from './setup-urls'
import type { SsoFormField } from './sso-field-errors'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'
import { useSsoConnectionForm, type SsoAttachTarget, type SsoCreateTextField } from './use-sso-connection-form'
import { CopyableField } from '../../components/copyable-field'
import { InlineError } from '../../components/inline-error'
import { BackOrCancel, backOrCancelFooterClass } from '../../components/back-or-cancel'

type SsoConnectionFormProps = {
  protocol: SsoProtocol
  /** Add the SSO side to this connection instead of creating one. */
  attachTo?: SsoAttachTarget
  onCreated: (connection: AdminConnectionDetail) => void
  onCancel: () => void
  /** Back to the picker this form was opened from; shown in place of Cancel. */
  onBack?: () => void
  onDirty: (dirty: boolean) => void
}

/** The form that adds an OIDC or SAML connection, or the SSO side of a SCIM-only one. */
export const SsoConnectionForm = ({
  protocol,
  attachTo,
  onCreated,
  onCancel,
  onBack,
  onDirty,
}: SsoConnectionFormProps) => {
  const { t, i18n } = useLingui()
  const idPrefix = useId()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const form = useSsoConnectionForm({ protocol, attachTo, onCreated, onDirty })
  const { draft } = form
  // Create stays off until every required field has a value, as the Skills form does.
  const requiredFields: SsoCreateTextField[] = [
    ...(attachTo ? [] : ['name' as const]),
    'providerId',
    ...(protocol === 'oidc'
      ? (['issuer', 'clientId', 'clientSecret'] as const)
      : (['entityId', 'entryPoint', 'idpIssuer', 'cert'] as const)),
  ]
  const canSubmit = requiredFields.every((field) => draft[field].trim() !== '')
  // The first field takes focus when the form opens.
  const firstField: SsoCreateTextField = attachTo ? 'providerId' : 'name'
  const firstFieldRef = useAutofocusOnMount<HTMLInputElement>(true)

  const errorFor = (field: SsoFormField) =>
    form.fieldError?.field === field ? i18n._(form.fieldError.message) : undefined

  /** One text input bound to a draft field, with its tooltip and inline error. */
  const textField = ({
    field,
    label,
    tooltip,
    required = true,
    type = 'text',
    multiline = false,
  }: {
    field: SsoCreateTextField
    label: string
    tooltip?: ReactNode
    required?: boolean
    type?: 'text' | 'url' | 'password'
    multiline?: boolean
  }) => {
    const id = `${idPrefix}-${field}`
    const error = errorFor(field)
    const inputProps = {
      id,
      value: draft[field],
      required,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy(id, { error }),
    }
    return (
      <FormField id={id} label={label} tooltip={tooltip} error={error}>
        {multiline ? (
          <Textarea
            {...inputProps}
            rows={5}
            className="font-mono"
            onChange={(event) => form.setField(field, event.target.value)}
          />
        ) : (
          <Input
            {...inputProps}
            ref={field === firstField ? firstFieldRef : undefined}
            type={type}
            autoComplete="off"
            onChange={(event) => form.setField(field, event.target.value)}
          />
        )}
      </FormField>
    )
  }

  const providerId = draft.providerId.trim()
  const presetId = `${idPrefix}-preset`

  return (
    <form className="flex flex-1 flex-col gap-5" onSubmit={form.submit}>
      {!attachTo && textField({ field: 'name', label: t`Name` })}
      <FormField id={presetId} label={<Trans>Identity provider</Trans>}>
        <Select value={draft.preset} onValueChange={(value) => form.setPreset(value as ProviderPreset)}>
          <SelectTrigger id={presetId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerPresets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {i18n._(preset.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {textField({ field: 'providerId', label: t`Provider ID` })}
      {providerId && (
        <FormGroup title={protocol === 'oidc' ? t`Redirect URI` : t`Assertion consumer service URL`}>
          <CopyableField
            label={protocol === 'oidc' ? t`Redirect URI` : t`Assertion consumer service URL`}
            copyLabel={protocol === 'oidc' ? t`Copy redirect URI` : t`Copy assertion consumer service URL`}
            value={protocol === 'oidc' ? oidcRedirectUri(cloudUrl, providerId) : samlAcsUrl(cloudUrl, providerId)}
          />
        </FormGroup>
      )}
      {protocol === 'oidc' ? (
        <>
          {textField({ field: 'issuer', label: t`Issuer`, type: 'url' })}
          {textField({ field: 'clientId', label: t`Client ID` })}
          {textField({ field: 'clientSecret', label: t`Client secret`, type: 'password' })}
          {textField({
            field: 'discoveryEndpoint',
            label: t`Discovery URL`,
            type: 'url',
            required: false,
          })}
        </>
      ) : (
        <>
          {textField({ field: 'entityId', label: t`Service provider entity ID` })}
          {textField({ field: 'entryPoint', label: t`Sign-in URL`, type: 'url' })}
          {textField({ field: 'idpIssuer', label: t`Identity provider issuer` })}
          {textField({ field: 'cert', label: t`Signing certificate`, multiline: true })}
        </>
      )}
      {textField({
        field: 'matchClaim',
        label: protocol === 'oidc' ? t`Match claim` : t`Match attribute`,
        required: false,
        tooltip: t`Must hold the person's SCIM externalId. Locks after the first sign-in.`,
      })}
      {draft.preset === 'entra' && (
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
          <Trans>In Entra, map externalId to objectId. The default, mailNickname, won't match.</Trans>
        </p>
      )}
      <FormFooter className={backOrCancelFooterClass(onBack)}>
        {onBack && <BackOrCancel onBack={onBack} onCancel={onCancel} />}
        <InlineError error={form.formError} className="min-w-0 flex-1 truncate" />
        {!onBack && <BackOrCancel onCancel={onCancel} />}
        <Button
          type="submit"
          disabled={!canSubmit}
          isLoading={form.isPending}
          loadingLabel={attachTo ? t`Adding…` : t`Creating…`}
        >
          {attachTo ? <Trans>Add</Trans> : <Trans>Create</Trans>}
        </Button>
      </FormFooter>
    </form>
  )
}
