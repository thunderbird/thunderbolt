/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId, useRef, useState, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { SearchInput } from '@/components/ui/search-input'
import { Switch } from '@/components/ui/switch'
import { useFormatters } from '@/i18n/use-formatters'
import type { AgentResource, AgentResourceKind } from './types'

const searchLabels = { model: msg`Search models`, mcp: msg`Search connections`, skill: msg`Search skills` }
const personalLabels = { model: msg`Your models`, mcp: msg`Your connections`, skill: msg`Your skills` }
const addLabels = { model: msg`Add model`, mcp: msg`Add connection`, skill: msg`Add skill` }

type ResourceSectionProps = {
  kind: AgentResourceKind
  title: string
  icon: ReactNode
  resources: AgentResource[]
  selectedIds: Set<string>
  onToggle: (id: string, selected: boolean) => void
  onAdd?: (kind: AgentResourceKind) => void
}

/** Shared personal/organization resource picker for models, MCPs, and skills. */
export const ResourceSection = ({
  kind,
  title,
  icon,
  resources,
  selectedIds,
  onToggle,
  onAdd,
}: ResourceSectionProps) => {
  const { t, i18n } = useLingui()
  const formatters = useFormatters()
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const query = search.trim().toLowerCase()
  const matching = resources.filter((resource) =>
    `${resource.name} ${resource.description}`.toLowerCase().includes(query),
  )
  const selectedCount = resources.filter((resource) => selectedIds.has(resource.id)).length

  const renderGroup = (scope: AgentResource['scope']) => {
    const items = matching.filter((resource) => resource.scope === scope)
    if (items.length === 0 && (query || scope === 'organization')) {
      return null
    }
    return (
      <section aria-labelledby={`${id}-${scope}`}>
        <h4 id={`${id}-${scope}`} className="mb-1 text-xs font-medium text-muted-foreground">
          {scope === 'personal' ? i18n._(personalLabels[kind]) : <Trans>Organization</Trans>}
        </h4>
        {items.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">
            <Trans>None yet</Trans>
          </p>
        )}
        {items.map((resource) => (
          <label
            key={resource.id}
            className="flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 max-md:py-2.5 -mx-2 hover:bg-accent/40"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{resource.name}</span>
              {resource.description && (
                <span className="block truncate text-xs text-muted-foreground">{resource.description}</span>
              )}
            </span>
            <Switch
              aria-label={resource.name}
              disabled={resource.disabled}
              checked={selectedIds.has(resource.id)}
              onCheckedChange={(checked) => onToggle(resource.id, checked)}
            />
          </label>
        ))}
      </section>
    )
  }

  return (
    <AccordionItem value={kind}>
      <AccordionTrigger className="cursor-pointer items-center py-3 hover:no-underline">
        <span className="flex items-center gap-2.5">
          <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-4">
            {icon}
          </span>
          {title}
        </span>
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {selectedCount > 0 ? t`${formatters.number(selectedCount)} selected` : t`None`}
        </span>
      </AccordionTrigger>
      <AccordionContent className="space-y-3 pb-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchInput
              ref={searchRef}
              showIcon
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={i18n._(searchLabels[kind])}
              aria-label={i18n._(searchLabels[kind])}
            />
          </div>
          {onAdd && (
            <Button type="button" size="sm" variant="outline" onClick={() => onAdd(kind)}>
              <Plus className="size-3.5" />
              {i18n._(addLabels[kind])}
            </Button>
          )}
        </div>
        {matching.length === 0 && query ? (
          <p role="status" className="py-3 text-sm text-muted-foreground">
            <Trans>No matches</Trans>
          </p>
        ) : (
          <div className="space-y-3 px-2 -mx-2">
            {renderGroup('personal')}
            {renderGroup('organization')}
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  )
}
