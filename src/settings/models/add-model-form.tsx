/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Loader2, X } from 'lucide-react'
import type { UseFormReturn } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxItem } from '@/components/ui/combobox'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusCard } from '@/components/ui/status-card'
import type { Model } from '@/types'
import { ConnectionTestSection } from './connection-test-section'
import { catalogRequiresApiKey, providerAutoFetchesCatalog, shouldDisableAddModel } from './model-policy'

export const addModelFormSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'anthropic', 'openai', 'custom', 'openrouter', 'tinfoil']),
    name: z.string().min(1, { message: 'Name is required.' }),
    model: z.string().min(1, { message: 'Model name is required.' }),
    customModel: z.string().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .refine((data) => data.provider !== 'custom' || Boolean(data.url), {
    message: 'URL is required for Custom providers',
    path: ['url'],
  })
  .refine(
    (data) =>
      data.provider === 'thunderbolt' ||
      data.provider === 'custom' ||
      (data.apiKey !== undefined && data.apiKey.length > 0),
    { message: 'API Key is required for this provider', path: ['apiKey'] },
  )

export type AddModelFormValues = z.infer<typeof addModelFormSchema>

type AddModelFormProps = {
  form: UseFormReturn<AddModelFormValues>
  modelItems: ComboboxItem[]
  selectedModelId: string | null
  isLoadingCatalog: boolean
  catalogError: string | null
  supportsTools: boolean
  isPending: boolean
  isTesting: boolean
  connectionStatus: 'idle' | 'success' | 'error'
  connectionError: string | null
  submitError: string | null
  onSubmit: (values: AddModelFormValues) => void
  onCancel: () => void
  onProviderChange: (provider: Model['provider']) => void
  onCatalogInvalidated: () => void
  onRefreshCatalog: () => void
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
  supportsTools,
  isPending,
  isTesting,
  connectionStatus,
  connectionError,
  submitError,
  onSubmit,
  onCancel,
  onProviderChange,
  onCatalogInvalidated,
  onRefreshCatalog,
  onSelectModel,
  onTestConnection,
}: AddModelFormProps) => {
  const provider = form.watch('provider')
  const apiKey = form.watch('apiKey')
  const url = form.watch('url')
  const model = form.watch('model')
  const showModelSelection =
    !catalogError &&
    (providerAutoFetchesCatalog(provider) || Boolean(apiKey) || (provider === 'custom' && Boolean(url)))

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4 pb-2 pt-4">
        <FormField
          control={form.control}
          name="provider"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Provider</FormLabel>
              <FormControl>
                <Select
                  onValueChange={(value: Model['provider']) => {
                    field.onChange(value)
                    onProviderChange(value)
                  }}
                  value={field.value}
                >
                  <SelectTrigger className="w-full rounded-lg">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="thunderbolt">Thunderbolt</SelectItem>
                    <SelectItem value="tinfoil">Tinfoil</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
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
                <FormLabel>URL</FormLabel>
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
                <FormLabel>API Key{provider === 'custom' ? ' (Optional)' : ''}</FormLabel>
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
        <Button
          type="button"
          variant="outline"
          disabled={isLoadingCatalog || (catalogRequiresApiKey(provider) && !apiKey) || (provider === 'custom' && !url)}
          onClick={onRefreshCatalog}
        >
          {isLoadingCatalog ? 'Refreshing models…' : 'Refresh model catalog'}
        </Button>
        {showModelSelection && (
          <FormField
            control={form.control}
            name="model"
            render={() => (
              <FormItem className="flex flex-col">
                <FormLabel>Model</FormLabel>
                <FormControl>
                  <Combobox
                    items={modelItems}
                    value={selectedModelId || undefined}
                    onValueChange={onSelectModel}
                    placeholder="Select model..."
                    searchPlaceholder="Search models..."
                    emptyMessage="No models found."
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
                <FormLabel>Model</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder="e.g., gpt-4-turbo-preview"
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
                <FormLabel>Display Name</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="e.g., GPT-4 Turbo" className="rounded-lg" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {!supportsTools && (model || selectedModelId === 'custom') && (
          <StatusCard
            icon={<X className="h-4 w-4 text-warning" />}
            title="Model may not be compatible"
            description="This model does not seem to support tool usage."
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
        />
        {submitError && (
          <StatusCard
            icon={<X className="h-4 w-4 text-destructive" />}
            title="Something went wrong"
            description={submitError}
          />
        )}
        <FormFooter>
          <ResponsiveModalCancel onClick={onCancel} />
          <Button
            type="submit"
            disabled={shouldDisableAddModel({
              isPending,
              isFormValid: form.formState.isValid,
              provider,
              connectionStatus,
            })}
          >
            {isPending ? 'Adding…' : 'Add Model'}
          </Button>
        </FormFooter>
      </form>
    </Form>
  )
}
