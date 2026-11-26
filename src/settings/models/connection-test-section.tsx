/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { StatusCard } from '@/components/ui/status-card'
import type { ModelConnectionTest } from '@/hooks/use-model-connection-test'
import type { Model } from '@/types'
import { providerRequiresApiKey, providerRequiresConnectionTest } from './model-policy'

type ConnectionTestSectionProps = {
  provider: Model['provider']
  model: string
  apiKey: string | undefined
  hasOAuth?: boolean
  connection: Pick<ModelConnectionTest, 'isTesting' | 'isLoadingModel' | 'status' | 'error' | 'toolSupport'>
  onTest: () => void
}

/** Determines whether the current provider fields are sufficient for a test. */
const canTestModelConnection = (provider: Model['provider'], model?: string, apiKey?: string | null) => {
  if (!providerRequiresConnectionTest(provider) || !model) {
    return false
  }
  return !providerRequiresApiKey(provider) || Boolean(apiKey)
}

/** Shared connection test controls and result presentation for model forms. */
export const ConnectionTestSection = ({
  provider,
  model,
  apiKey,
  hasOAuth = false,
  connection,
  onTest,
}: ConnectionTestSectionProps) => {
  const { t } = useLingui()
  const { isTesting, isLoadingModel, status, error, toolSupport } = connection
  const canTest = (hasOAuth && Boolean(model)) || canTestModelConnection(provider, model, apiKey)
  const showApiKeyHint = !canTest && Boolean(model) && providerRequiresApiKey(provider)

  return (
    <>
      {canTest && (
        <Button type="button" onClick={onTest} disabled={isTesting} variant="outline" className="w-full">
          {isTesting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {isLoadingModel ? <Trans>Loading model…</Trans> : <Trans>Testing model…</Trans>}
            </>
          ) : (
            <Trans>Test model</Trans>
          )}
        </Button>
      )}
      {isLoadingModel && (
        <p className="text-center text-sm text-muted-foreground">
          <Trans>Local models can take a few minutes to load the first time.</Trans>
        </p>
      )}
      {showApiKeyHint && (
        <p className="text-center text-sm text-muted-foreground">
          <Trans>Enter an API key to test the connection before saving.</Trans>
        </p>
      )}
      {status === 'success' && toolSupport === 'unsupported' && (
        <StatusCard
          icon={<AlertTriangle className="h-4 w-4 text-warning" />}
          title={t`Connected without tools`}
          description={t`This model doesn't support tools, so chats will run without them. Tools have been turned off below.`}
        />
      )}
      {status === 'success' && toolSupport !== 'unsupported' && (
        <StatusCard
          icon={<Check className="h-4 w-4 text-success" />}
          title={t`Test successful!`}
          description={t`Successfully got a response from the model.`}
        />
      )}
      {status === 'error' && (
        <StatusCard
          icon={<X className="h-4 w-4 text-destructive" />}
          title={t`Test failed`}
          description={error || t`Received an error while testing the model.`}
        />
      )}
    </>
  )
}
