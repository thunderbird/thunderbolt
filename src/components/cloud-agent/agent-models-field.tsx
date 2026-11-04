/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { verticalAxisModifiers } from '@/lib/dnd'
import { AgentModelRow } from './agent-model-row'
import { Link } from 'react-router'
import type { CloudAgentModel } from '@shared/cloud-agent/contracts'
import {
  agentModelOptions,
  enabledAgentModels,
  reorderAgentModelOptions,
  type AgentModelChoice,
  type AgentModelOption,
} from './agent-model-options'

/** Enabled models retain their explicit order independently of the model library's order. */
export const AgentModelsField = ({
  models,
  choices,
  order,
  onOrderChange,
  onChange,
}: {
  models: CloudAgentModel[]
  choices: AgentModelChoice[]
  order?: string[]
  onOrderChange: (order: string[]) => void
  onChange: (models: CloudAgentModel[]) => void
}) => {
  const { t } = useLingui()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const options = agentModelOptions(models, choices, order)
  const defaultId = options.find((entry) => entry.enabled)?.id
  const update = (next: AgentModelOption[]) => {
    onChange(enabledAgentModels(next))
    onOrderChange(next.map((entry) => entry.id))
  }
  return (
    <section className="flex flex-col gap-3" aria-label={t`Models`}>
      <div className="flex justify-end">
        <Link to="/settings/models" className="text-sm text-primary underline underline-offset-4">
          <Trans>Manage models</Trans>
        </Link>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={verticalAxisModifiers}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id) {
            return
          }
          update(reorderAgentModelOptions(options, String(active.id), String(over.id)))
        }}
      >
        <SortableContext items={options.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1" data-base-ui-swipe-ignore>
            {options.map(({ name, id, enabled }) => (
              <AgentModelRow
                key={id}
                id={id}
                name={name}
                isDefault={id === defaultId}
                enabled={enabled}
                onToggle={(enabled) =>
                  update(options.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)))
                }
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {models.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>At least one model required</Trans>
        </p>
      )}
    </section>
  )
}
