/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { StatusCard } from '@/components/ui/status-card'
import type { Model } from '@/types'
import { ConnectionTestSection } from './connection-test-section'
import { useEditModelFormState, type EditModelSubmission } from './use-edit-model-form-state'

export type { EditModelSubmission } from './use-edit-model-form-state'

type EditModelFormProps = {
  model: Model
  onCancel: () => void
  onSubmit: (values: EditModelSubmission) => void
  isPending: boolean
  submitError: string | null
}

/** Presentational model edit form driven by useEditModelFormState. */
export const EditModelForm = ({ model, onCancel, onSubmit, isPending, submitError }: EditModelFormProps) => {
  const state = useEditModelFormState(model)

  return (
    <Form {...state.form}>
      <form
        onSubmit={state.form.handleSubmit((values) => onSubmit(state.submissionFor(values)))}
        className="flex flex-1 flex-col gap-4 pb-2 pt-4"
      >
        <FormField
          control={state.form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} className="rounded-lg" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={state.form.control}
          name="model"
          render={({ field }) => (
            <FormItem className="flex flex-col">
              <FormLabel>Model</FormLabel>
              <FormControl>
                {state.isCustomModel ? (
                  <Input {...field} placeholder="e.g., gpt-4-turbo-preview" className="rounded-lg" />
                ) : (
                  <div className="flex gap-2">
                    <Combobox
                      items={state.modelItems}
                      value={state.watchedModel}
                      onValueChange={state.selectModel}
                      placeholder="Select model..."
                      searchPlaceholder="Search models..."
                      emptyMessage="No models found."
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={state.refreshCatalog}
                      disabled={state.isLoadingCatalog}
                    >
                      {state.isLoadingCatalog ? 'Refreshing…' : 'Refresh'}
                    </Button>
                  </div>
                )}
              </FormControl>
              {state.catalogError && <p className="text-sm text-destructive">{state.catalogError}</p>}
              <FormMessage />
            </FormItem>
          )}
        />
        {model.provider === 'custom' && (
          <FormField
            control={state.form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>URL</FormLabel>
                <FormControl>
                  <Input {...field} className="rounded-lg" onChange={(event) => state.changeUrl(event.target.value)} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {model.provider !== 'thunderbolt' && (
          <FormField
            control={state.form.control}
            name="apiKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>API Key</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    {...field}
                    onChange={(event) => state.changeApiKey(event.target.value)}
                    placeholder={model.apiKey ? '••••••••••••••••' : 'sk-...'}
                    className="rounded-lg"
                  />
                </FormControl>
                {model.apiKey && (
                  <Button type="button" variant="ghost" className="mt-1" onClick={state.toggleClearApiKey}>
                    {state.apiKeyEdit.kind === 'clear' ? 'Keep saved API key' : 'Clear saved API key'}
                  </Button>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <ConnectionTestSection
          provider={model.provider}
          model={state.watchedModel}
          apiKey={state.effectiveApiKey}
          isTesting={state.connection.isTesting}
          onTest={state.testConnection}
          status={state.connection.status}
          error={state.connection.error}
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
          <Button type="submit" disabled={isPending || state.isSaveDisabled}>
            Save
          </Button>
        </FormFooter>
      </form>
    </Form>
  )
}
