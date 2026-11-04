/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { BookOpen, Brain, Plug, SlidersHorizontal } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'
import { ResourceSection } from './resource-section'
import { AgentFormFooter } from './agent-form-footer'
import { AgentSuggestionStatus } from './agent-suggestion-status'
import { AgentNameField } from './agent-name-field'
import type { AgentResource, AgentResourceKind } from './types'
import type { AddAgentController } from './use-add-agent-state'

type ThunderboltAgentFormProps = {
  modelsField?: ReactNode
  controller: AddAgentController
  resources: AgentResource[]
  onClose: () => void
  onCreate: () => void
  saving?: boolean
  onAddResource?: (kind: AgentResourceKind) => void
}

/** Select saved models and tools before creating the agent. */
export const ThunderboltAgentForm = ({
  controller,
  modelsField,
  resources,
  onClose,
  onCreate,
  saving,
  onAddResource,
}: ThunderboltAgentFormProps) => {
  const { t } = useLingui()
  const formRef = useAutofocusOnMount<HTMLFormElement>()
  const { draft, edit, toggle, selectedResources, canPreview, hasModel } = controller
  const selectedIds = new Set(selectedResources.map((resource) => resource.id))

  return (
    <form
      ref={formRef}
      tabIndex={-1}
      aria-label={t`Models & tools`}
      className="flex flex-1 flex-col gap-4 outline-none"
      onSubmit={(event) => {
        event.preventDefault()
        onCreate()
      }}
    >
      <AgentNameField controller={controller} />
      <div>
        <Accordion type="single" collapsible defaultValue="model" className="border-y border-border/60">
          {modelsField ? (
            modelsField
          ) : (
            <ResourceSection
              onAdd={onAddResource}
              kind="model"
              title={t`Models`}
              icon={<Brain />}
              resources={resources.filter((resource) => resource.kind === 'model')}
              selectedIds={selectedIds}
              onToggle={toggle}
            />
          )}
          <ResourceSection
            onAdd={onAddResource}
            kind="mcp"
            title={t`Connections`}
            icon={<Plug />}
            resources={resources.filter((resource) => resource.kind === 'mcp')}
            selectedIds={selectedIds}
            onToggle={toggle}
          />
          <ResourceSection
            onAdd={onAddResource}
            kind="skill"
            title={t`Skills`}
            icon={<BookOpen />}
            resources={resources.filter((resource) => resource.kind === 'skill')}
            selectedIds={selectedIds}
            onToggle={toggle}
          />
          <AccordionItem value="instructions">
            <AccordionTrigger className="cursor-pointer items-center py-3 hover:no-underline">
              <span className="flex items-center gap-2.5">
                <SlidersHorizontal className="size-4 text-muted-foreground" />
                <Trans>System prompt</Trans>
              </span>
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {draft.systemPrompt.trim() ? <Trans>Custom</Trans> : <Trans>Optional</Trans>}
              </span>
            </AccordionTrigger>
            <AccordionContent className="pb-3">
              <Textarea
                aria-label={t`Custom system prompt`}
                className="min-h-32 max-h-80"
                value={draft.systemPrompt}
                onChange={(event) => edit({ systemPrompt: event.target.value })}
              />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        {!hasModel && (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            <Trans>At least one model required</Trans>
          </p>
        )}
      </div>
      <AgentSuggestionStatus controller={controller} />
      <AgentFormFooter onBack={controller.back}>
        <Button type="button" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!canPreview || saving}>
          {saving ? <Trans>Creating…</Trans> : <Trans>Create agent</Trans>}
        </Button>
      </AgentFormFooter>
    </form>
  )
}
