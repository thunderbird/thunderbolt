/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { StatusCard } from '@/components/ui/status-card'
import type { Model } from '@/types'
import { ConnectionTestSection } from './connection-test-section'
import { providerRequiresUrl } from './model-policy'
import { SupportsToolsSwitch } from './supports-tools-switch'
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
  const { t } = useLingui()
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
              <FormLabel>
                <Trans>Name</Trans>
              </FormLabel>
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
              <FormLabel>
                <Trans>Model</Trans>
              </FormLabel>
              <FormControl>
                {state.isCustomModel ? (
                  <Input {...field} placeholder={t`e.g., gpt-4-turbo-preview`} className="rounded-lg" />
                ) : (
                  <Combobox
                    items={state.modelItems}
                    value={state.watchedModel}
                    onValueChange={state.selectModel}
                    onOpenChange={(open) => open && state.loadCatalog()}
                    placeholder={t`Select model…`}
                    searchPlaceholder={t`Search models…`}
                    emptyMessage={t`No models found.`}
                    loading={state.isLoadingCatalog}
                  />
                )}
              </FormControl>
              {state.catalogError && <p className="text-sm text-destructive">{state.catalogError}</p>}
              <FormMessage />
            </FormItem>
          )}
        />
        {model.providerConnectionId && (
          <Link
            to="/settings/connections"
            state={{ providerConnectionId: model.providerConnectionId }}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            <Trans>Manage provider connection</Trans>
          </Link>
        )}
        {!model.providerConnectionId && providerRequiresUrl(model.provider) && (
          <FormField
            control={state.form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>URL</Trans>
                </FormLabel>
                <FormControl>
                  <Input {...field} className="rounded-lg" onChange={(event) => state.changeUrl(event.target.value)} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {!model.providerConnectionId && model.provider !== 'thunderbolt' && !model.oauthProvider && (
          <FormField
            control={state.form.control}
            name="apiKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  <Trans>API Key</Trans>
                </FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    {...field}
                    onChange={(event) => state.changeApiKey(event.target.value)}
                    placeholder={state.hasStoredApiKey ? '••••••••••••••••' : 'sk-...'}
                    className="rounded-lg"
                  />
                </FormControl>
                {state.isStoredApiKeyLeftBehind && (
                  <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                    <Trans>
                      The saved API key is only sent to the URL it was saved for. Enter it again to use this URL.
                    </Trans>
                  </p>
                )}
                {state.hasStoredApiKey && (
                  <Button type="button" variant="ghost" className="mt-1" onClick={state.toggleClearApiKey}>
                    {state.apiKeyEdit.kind === 'clear' ? (
                      <Trans>Keep saved API key</Trans>
                    ) : (
                      <Trans>Clear saved API key</Trans>
                    )}
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
          hasOAuth={Boolean(model.providerConnectionId || model.oauthProvider)}
          connection={state.connection}
          onTest={state.testConnection}
        />
        {model.provider !== 'thunderbolt' && (
          <SupportsToolsSwitch
            checked={state.form.watch('supportsTools')}
            onCheckedChange={state.changeSupportsTools}
            disabled={state.connection.isTesting}
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
            loadingLabel={t`Saving…`}
            disabled={isPending || state.isSaveDisabled}
          >
            <Trans>Save</Trans>
          </Button>
        </FormFooter>
      </form>
    </Form>
  )
}
