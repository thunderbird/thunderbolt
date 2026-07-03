/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getProviderDefinition, MODEL_PROVIDER_ORDER, type ProviderType } from '@shared/providers'
import { Check, Cpu, Loader2 } from 'lucide-react'
import { IconCircle } from './icon-circle'
import { useOnboardingModelStep } from './use-onboarding-model-step'

type Props = {
  /** Advance to the next step (hard gate already satisfied). */
  onComplete: () => void
  /** Skip with a warning + persistent nag. */
  onSkip: () => void
}

/**
 * Model-provider onboarding step (spec-standalone §7). Provider dropdown ordered
 * per MODEL_PROVIDER_ORDER, connection inputs by connectionType, a hard-gated
 * test on connect, and a "Try a free model" affordance. Skippable with a nag.
 */
export const OnboardingModelProviderStep = ({ onComplete, onSkip }: Props) => {
  const step = useOnboardingModelStep()
  const def = getProviderDefinition(step.state.type)
  const busy = step.state.status === 'connecting'
  const comingSoon = def.comingSoon === true
  const options = MODEL_PROVIDER_ORDER.map(getProviderDefinition)

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-3">
        <IconCircle>
          <Cpu className="w-8 h-8" />
        </IconCircle>
        <h2 className="text-2xl font-bold">Connect a model provider</h2>
        <p className="text-muted-foreground">
          Bring your own account so your assistant can think. You can add more later.
        </p>
      </div>

      <div className="pt-6 space-y-4">
        <Select value={step.state.type} onValueChange={(v) => step.setType(v as ProviderType)} disabled={busy}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((p) => (
              <SelectItem key={p.type} value={p.type} disabled={p.comingSoon === true}>
                {p.name}
                {p.comingSoon ? ' (coming soon)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {def.connectionType === 'url' && (
          <Input
            placeholder="Base URL"
            value={step.state.baseUrl}
            onChange={(e) => step.setBaseUrl(e.target.value)}
            disabled={busy}
          />
        )}
        {(def.connectionType === 'api-key' || def.connectionType === 'url') && (
          <Input
            type="password"
            placeholder={def.connectionType === 'url' ? 'API key (optional)' : 'API key'}
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
            <Check className="size-4" /> Connected and tested.
          </p>
        )}

        {comingSoon ? (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {def.name} isn’t available to connect yet. Pick another provider or skip for now.
          </p>
        ) : (
          <Button className="w-full" onClick={step.connect} disabled={busy || step.isConnected}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            {def.connectionType === 'oauth-pkce' ? `Sign in with ${def.name}` : `Connect ${def.name}`}
          </Button>
        )}

        <Button
          variant="ghost"
          className="w-full"
          disabled={busy || step.isConnected}
          onClick={async () => {
            if (await step.tryFree()) {
              onComplete()
            }
          }}
        >
          Try a free model
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
