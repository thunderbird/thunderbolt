/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, type ReactNode } from 'react'
import { CopyCommandRow } from '@/components/settings/copy-command-row'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AdminConnectionDetail, SsoProtocol } from '@shared/admin-api'
import { getAdminErrorMessage } from '../../api/error-messages'
import { describedBy, FormField } from './form-field'
import { providerPresets, type ProviderPreset } from './provider-presets'
import { oidcRedirectUri, samlAcsUrl } from './setup-urls'
import type { SsoFormField } from './sso-field-errors'
import { useSsoConnectionForm, type SsoAttachTarget, type SsoCreateTextField } from './use-sso-connection-form'

type SsoConnectionFormProps = {
  protocol: SsoProtocol
  /** Add the SSO side to this connection instead of creating one. */
  attachTo?: SsoAttachTarget
  onCreated: (connection: AdminConnectionDetail) => void
  onCancel: () => void
  onDirty: (dirty: boolean) => void
}

/** The form that adds an OIDC or SAML connection, or the SSO side of a SCIM-only one. */
export const SsoConnectionForm = ({ protocol, attachTo, onCreated, onCancel, onDirty }: SsoConnectionFormProps) => {
  const { t, i18n } = useLingui()
  const idPrefix = useId()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const form = useSsoConnectionForm({ protocol, attachTo, onCreated, onDirty })
  const { draft } = form

  const errorFor = (field: SsoFormField) =>
    form.fieldError?.field === field ? i18n._(form.fieldError.message) : undefined

  /** One text input bound to a draft field, with its hint and inline error. */
  const textField = ({
    field,
    label,
    hint,
    required = true,
    type = 'text',
    multiline = false,
  }: {
    field: SsoCreateTextField
    label: string
    hint?: ReactNode
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
      'aria-describedby': describedBy(id, { hint, error }),
    }
    return (
      <FormField id={id} label={label} hint={hint} error={error}>
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
      {!attachTo && textField({ field: 'name', label: t`Name`, hint: t`Shown on the sign-in screen.` })}
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
      {textField({
        field: 'providerId',
        label: t`Provider ID`,
        hint: t`Lowercase letters, numbers and hyphens. It appears in the URLs you give your identity provider and can't change later.`,
      })}
      {providerId && (
        <div className="flex flex-col gap-1">
          <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {protocol === 'oidc' ? <Trans>Redirect URI</Trans> : <Trans>Assertion consumer service URL</Trans>}
          </span>
          <CopyCommandRow
            command={protocol === 'oidc' ? oidcRedirectUri(cloudUrl, providerId) : samlAcsUrl(cloudUrl, providerId)}
            label={protocol === 'oidc' ? t`Copy redirect URI` : t`Copy assertion consumer service URL`}
          />
        </div>
      )}
      {protocol === 'oidc' ? (
        <>
          {textField({
            field: 'issuer',
            label: t`Issuer`,
            type: 'url',
            hint: t`Identifies the provider and can't change later.`,
          })}
          {textField({ field: 'clientId', label: t`Client ID` })}
          {textField({ field: 'clientSecret', label: t`Client secret`, type: 'password' })}
          {textField({
            field: 'discoveryEndpoint',
            label: t`Discovery URL`,
            type: 'url',
            required: false,
            hint: t`Optional. Leave blank to use the issuer's.`,
          })}
        </>
      ) : (
        <>
          {textField({
            field: 'entityId',
            label: t`Service provider entity ID`,
            hint: t`Names this app to your identity provider and can't change later.`,
          })}
          {textField({ field: 'entryPoint', label: t`Sign-in URL`, type: 'url' })}
          {textField({ field: 'idpIssuer', label: t`Identity provider issuer`, hint: t`Can't change later.` })}
          {textField({ field: 'cert', label: t`Signing certificate`, multiline: true })}
        </>
      )}
      {textField({
        field: 'matchClaim',
        label: protocol === 'oidc' ? t`Match claim` : t`Match attribute`,
        required: false,
        hint: t`Its value must be the person's SCIM externalId. It decides which account a sign-in belongs to, and it locks once someone signs in.`,
      })}
      {draft.preset === 'entra' && (
        <Alert>
          <AlertDescription>
            <Trans>
              In Entra's provisioning attribute mappings, map externalId to objectId. Entra sends mailNickname by
              default, which won't match.
            </Trans>
          </AlertDescription>
        </Alert>
      )}
      {form.formError && (
        <p role="alert" className="text-destructive">
          {i18n._(getAdminErrorMessage(form.formError))}
        </p>
      )}
      <FormFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isLoading={form.isPending}>
          {attachTo ? <Trans>Add single sign-on</Trans> : <Trans>Create connection</Trans>}
        </Button>
      </FormFooter>
    </form>
  )
}
