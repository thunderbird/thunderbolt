/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'

import { AgentFormFooter } from './agent-form-footer'
import { AgentSuggestionStatus } from './agent-suggestion-status'
import { AgentNameField } from './agent-name-field'
import type { AddAgentController } from './use-add-agent-state'

type AgentBasicsFormProps = {
  controller: AddAgentController
  desktopAvailable: boolean
  onClose: () => void
}

/** Start with the agent's purpose before choosing its capabilities. */
export const AgentBasicsForm = ({ controller, onClose }: AgentBasicsFormProps) => {
  const { t } = useLingui()
  const id = useId()
  const purposeRef = useAutofocusOnMount<HTMLTextAreaElement>()
  const { draft, edit, next, canContinueBasics } = controller
  const starters = [
    { label: t`Review code`, prompt: t`Review pull requests for bugs, security issues, and maintainability.` },
    { label: t`Find jobs`, prompt: t`Find jobs that match my experience and interests.` },
    { label: t`Prepare daily briefs`, prompt: t`Compile a daily briefing on the news and topics I follow.` },
  ]

  return (
    <form
      className="flex flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        next()
      }}
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-description`}>
            <Trans>What will this agent do?</Trans>
          </Label>
          <Textarea
            ref={purposeRef}
            id={`${id}-description`}
            className="min-h-28 max-h-60 md:min-h-28"
            value={draft.description}
            onChange={(event) => edit({ description: event.target.value })}
            onBlur={() => void controller.suggest()}
            placeholder={t`Review pull requests and catch bugs`}
            maxLength={1000}
            required
          />
          {!draft.description.trim() && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {starters.map((starter) => (
                <Button
                  key={starter.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => controller.selectStarter(starter.prompt)}
                >
                  {starter.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        {controller.showName && <AgentNameField controller={controller} />}
        <AgentSuggestionStatus controller={controller} />
      </div>
      <AgentFormFooter onBack={controller.back}>
        <Button type="button" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!canContinueBasics}>
          <Trans>Continue</Trans>
          <ArrowRight className="size-4" />
        </Button>
      </AgentFormFooter>
    </form>
  )
}
