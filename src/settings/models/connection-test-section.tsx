/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Check, Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { StatusCard } from '@/components/ui/status-card'
import type { Model } from '@/types'
import { providerRequiresApiKey, providerRequiresConnectionTest } from './model-policy'

type ConnectionTestSectionProps = {
  provider: Model['provider']
  model: string
  apiKey: string | undefined
  isTesting: boolean
  onTest: () => void
  status: 'idle' | 'success' | 'error'
  error: string | null
}

/** Determines whether the current provider fields are sufficient for a test. */
export const canTestModelConnection = (provider: Model['provider'], model?: string, apiKey?: string | null) => {
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
  isTesting,
  onTest,
  status,
  error,
}: ConnectionTestSectionProps) => {
  const canTest = canTestModelConnection(provider, model, apiKey)
  const showApiKeyHint = !canTest && Boolean(model) && providerRequiresApiKey(provider)

  return (
    <>
      {canTest && (
        <Button type="button" onClick={onTest} disabled={isTesting} variant="outline" className="w-full">
          {isTesting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Testing model…
            </>
          ) : (
            'Test Model'
          )}
        </Button>
      )}
      {showApiKeyHint && (
        <p className="text-center text-sm text-muted-foreground">
          Enter an API key to test the connection before saving.
        </p>
      )}
      {status === 'success' && (
        <StatusCard
          title={
            <>
              <Check className="h-5 w-5 text-success" />
              Test successful!
            </>
          }
          description="Successfully got a response from the model."
        />
      )}
      {status === 'error' && (
        <StatusCard
          title={
            <>
              <X className="h-5 w-5 text-destructive" />
              Test failed
            </>
          }
          description={error || 'Received an error while testing the model.'}
        />
      )}
    </>
  )
}
