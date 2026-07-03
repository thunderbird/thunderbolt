/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getProviderDefinition, SEARCH_PROVIDER_ORDER, type ProviderType } from '@shared/providers'
import { Check, Loader2, Search } from 'lucide-react'
import { IconCircle } from './icon-circle'
import { useOnboardingSearchStep } from './use-onboarding-search-step'

type Props = {
  onComplete: () => void
  onSkip: () => void
}

/**
 * Search-provider onboarding step (spec-standalone §8). Dropdown of search
 * providers (incl. free DuckDuckGo), a hard-gated test search on connect, and a
 * skip path with a nag. Auto-skip (when a provider already supplies search) is
 * handled upstream by the flow sequencing.
 */
export const OnboardingSearchProviderStep = ({ onComplete, onSkip }: Props) => {
  const step = useOnboardingSearchStep()
  const def = getProviderDefinition(step.state.type)
  const busy = step.state.status === 'connecting'
  const options = SEARCH_PROVIDER_ORDER.map(getProviderDefinition)
  const needsKey = def.connectionType === 'api-key'
  const needsUrl = def.connectionType === 'url' && !def.free

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-3">
        <IconCircle>
          <Search className="w-8 h-8" />
        </IconCircle>
        <h2 className="text-2xl font-bold">Set up web search</h2>
        <p className="text-muted-foreground">
          Let your assistant search the web. Use your own provider or free search.
        </p>
      </div>

      <div className="pt-6 space-y-4">
        <Select value={step.state.type} onValueChange={(v) => step.setType(v as ProviderType)} disabled={busy}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((p) => (
              <SelectItem key={p.type} value={p.type}>
                {p.type === 'duckduckgo' ? 'Free local search via DuckDuckGo' : p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {needsUrl && (
          <Input
            placeholder="Base URL"
            value={step.state.baseUrl}
            onChange={(e) => step.setBaseUrl(e.target.value)}
            disabled={busy}
          />
        )}
        {needsKey && (
          <Input
            type="password"
            placeholder="API key"
            value={step.state.apiKey}
            onChange={(e) => step.setApiKey(e.target.value)}
            disabled={busy}
          />
        )}

        {step.state.status === 'error' && step.state.error && (
          <p className="text-[length:var(--font-size-sm)] text-destructive">{step.state.error}</p>
        )}
        {step.isConnected && (
          <p className="flex items-center gap-2 text-[length:var(--font-size-sm)] text-green-600">
            <Check className="size-4" /> Search is working.
          </p>
        )}

        <Button className="w-full" onClick={step.connect} disabled={busy || step.isConnected}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
          {def.free ? 'Test free search' : `Connect ${def.name}`}
        </Button>
      </div>

      <div className="flex gap-2 pt-6">
        <Button variant="ghost" className="flex-1" onClick={onSkip} disabled={busy}>
          Skip for now
        </Button>
        <Button className="flex-1" onClick={onComplete} disabled={!step.isConnected}>
          Continue
        </Button>
      </div>
    </div>
  )
}
