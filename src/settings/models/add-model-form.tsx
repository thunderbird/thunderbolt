/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Loader2, X } from 'lucide-react'
import type { UseFormReturn } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxItem } from '@/components/ui/combobox'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusCard } from '@/components/ui/status-card'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'
import type { ToolSupport } from '@/hooks/use-model-connection-test'
import { useAppName } from '@/lib/branding-selectors'
import type { Model } from '@/types'
import { ConnectionTestSection } from './connection-test-section'
import { providerAutoFetchesCatalog, shouldDisableAddModel } from './model-policy'
import { getProviderLabel, providerPickerOrder } from './model-presentation'
import { SupportsToolsSwitch } from './supports-tools-switch'
import type { AddModelFormValues } from './use-add-model-form'

type AddModelFormProps = {
  form: UseFormReturn<AddModelFormValues>
  modelItems: ComboboxItem[]
  selectedModelId: string | null
  isLoadingCatalog: boolean
  catalogError: string | null
  isPending: boolean
  isTesting: boolean
  connectionStatus: 'idle' | 'success' | 'error'
  connectionError: string | null
  toolSupport: ToolSupport | null
  submitError: string | null
  onSubmit: (values: AddModelFormValues) => void
  onCancel: () => void
  onProviderChange: (provider: Model['provider']) => void
  onCatalogInvalidated: () => void
  onSelectModel: (id: string) => void
  onTestConnection: () => void
}

/** Presentational add-model form; provider and mutation behavior stays in the page controller. */
export const AddModelForm = ({
  form,
  modelItems,
  selectedModelId,
  isLoadingCatalog,
  catalogError,
  isPending,
  isTesting,
  connectionStatus,
  connectionError,
  toolSupport,
  submitError,
  onSubmit,
  onCancel,
  onProviderChange,
  onCatalogInvalidated,
  onSelectModel,
  onTestConnection,
}: AddModelFormProps) => {
  const { i18n, t } = useLingui()
  const appName = useAppName()
  const provider = form.watch('provider')
  const apiKey = form.watch('apiKey')
  const url = form.watch('url')
  const model = form.watch('model')
  const supportsTools = form.watch('supportsTools')

  // The user just chose "New Model" / "Add Model" — land ready to pick a
  // provider (the form's first control).
  const providerTriggerRef = useAutofocusOnMount<HTMLButtonElement>()

  // Stays visible when the catalog fails: its "Custom" entry is the manual fallback.
  const showModelSelection =
    providerAutoFetchesCatalog(provider) || Boolean(apiKey) || (provider === 'custom' && Boolean(url))

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4 pb-2 pt-4">
        <FormField
          control={form.control}
          name="provider"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                <Trans>Provider</Trans>
              </FormLabel>
              <Select
                onValueChange={(value: Model['provider']) => {
                  onProviderChange(value)
                }}
                value={field.value}
              >
                <FormControl>
                  <SelectTrigger ref={providerTriggerRef} className="w-full rounded-lg">
                    <SelectValue placeholder={t`Select provider`} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {providerPickerOrder.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {getProviderLabel(i18n, provider, appName)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        {provider === 'custom' && (
          <FormField
            control={form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>URL</Trans>
                </FormLabel>
                <FormControl>
                  <div className="relative">
                    <Input
                      {...field}
                      placeholder="http://localhost:11434/v1"
                      className="rounded-lg pr-10"
                      onChange={(event) => {
                        field.onChange(event)
                        onCatalogInvalidated()
                      }}
                    />
                    {isLoadingCatalog && (
                      <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                  </div>
                </FormControl>
                {catalogError && <p className="mt-1 whitespace-pre-line text-sm text-destructive">{catalogError}</p>}
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {provider !== 'thunderbolt' && (
          <FormField
            control={form.control}
            name="apiKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {provider === 'custom' ? <Trans>API Key (Optional)</Trans> : <Trans>API Key</Trans>}
                </FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    {...field}
                    placeholder="sk-..."
                    className="rounded-lg"
                    onChange={(event) => {
                      field.onChange(event)
                      onCatalogInvalidated()
                    }}
                  />
                </FormControl>
                {catalogError && provider !== 'custom' && (
                  <p className="mt-1 whitespace-pre-line text-sm text-destructive">{catalogError}</p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {showModelSelection && (
          <FormField
            control={form.control}
            name="model"
            render={() => (
              <FormItem className="flex flex-col">
                <FormLabel>
                  <Trans>Model</Trans>
                </FormLabel>
                <FormControl>
                  <Combobox
                    items={modelItems}
                    value={selectedModelId || undefined}
                    onValueChange={onSelectModel}
                    placeholder={t`Select model…`}
                    searchPlaceholder={t`Search models…`}
                    emptyMessage={t`No models found.`}
                    loading={isLoadingCatalog}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {selectedModelId === 'custom' && (
          <FormField
            control={form.control}
            name="customModel"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Model</Trans>
                </FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder={t`e.g., gpt-4-turbo-preview`}
                    className="rounded-lg"
                    onChange={(event) => {
                      field.onChange(event)
                      form.setValue('model', event.target.value, { shouldValidate: true })
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {(model || selectedModelId === 'custom') && (
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>Display Name</Trans>
                </FormLabel>
                <FormControl>
                  <Input {...field} placeholder={t`e.g., GPT-4 Turbo`} className="rounded-lg" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <ConnectionTestSection
          provider={provider}
          model={model}
          apiKey={apiKey}
          isTesting={isTesting}
          onTest={onTestConnection}
          status={connectionStatus}
          error={connectionError}
          toolSupport={toolSupport}
        />
        {provider !== 'thunderbolt' && (
          <SupportsToolsSwitch
            checked={supportsTools}
            onCheckedChange={(checked) => form.setValue('supportsTools', checked)}
            disabled={isTesting}
          />
        )}
        {submitError && (
          <StatusCard
            icon={<X className="h-4 w-4 text-destructive" />}
            title={t`Something went wrong`}
            description={submitError}
          />
        )}
        <FormFooter>
          <ResponsiveModalCancel onClick={onCancel} />
          <Button
            type="submit"
            isLoading={isPending}
            loadingLabel={t`Adding…`}
            disabled={shouldDisableAddModel({
              isPending,
              isFormValid: form.formState.isValid,
              provider,
              connectionStatus,
            })}
          >
            <Trans>Add Model</Trans>
          </Button>
        </FormFooter>
      </form>
    </Form>
  )
}
