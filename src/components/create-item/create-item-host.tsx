/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Loader2 } from 'lucide-react'
import { lazy, Suspense, useRef } from 'react'

import { DetailPanel } from '@/components/detail-panel'
import { CreateItemSurface } from './create-item-surface'
import { type CreateItemRequest, useCreateItem } from './context'

const CreateSkillPanel = lazy(() =>
  import('./create-skill-panel').then((module) => ({ default: module.CreateSkillPanel })),
)
const CreateAgentPanel = lazy(() =>
  import('./create-agent-panel').then((module) => ({ default: module.CreateAgentPanel })),
)
const CreateModelPanel = lazy(() =>
  import('./create-model-panel').then((module) => ({ default: module.CreateModelPanel })),
)

const titles: Record<CreateItemRequest['kind'], string> = {
  skill: 'Create Skill',
  agent: 'Add Custom Agent',
  model: 'Add Model',
}

const LoadingPanel = ({
  request,
  open,
  onClose,
}: {
  request: CreateItemRequest
  open: boolean
  onClose: () => void
}) => (
  <CreateItemSurface open={open} onClose={onClose}>
    <DetailPanel title={titles[request.kind]} onClose={onClose}>
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
      </div>
    </DetailPanel>
  </CreateItemSurface>
)

/**
 * Keeps the last request mounted while its surface animates closed. A new
 * request id remounts its form so reopening always starts clean.
 */
export const CreateItemHost = () => {
  const { request, surfaceOpen, closeCreateItem } = useCreateItem()
  const lastRequest = useRef<CreateItemRequest | null>(request)

  if (request) {
    lastRequest.current = request
  }

  const renderedRequest = request ?? lastRequest.current
  if (!renderedRequest) {
    return null
  }

  const open = surfaceOpen && request?.id === renderedRequest.id
  const sharedProps = { open, onClose: closeCreateItem }

  const panel = (() => {
    switch (renderedRequest.kind) {
      case 'skill':
        return <CreateSkillPanel {...sharedProps} initialName={renderedRequest.initialName} />
      case 'agent':
        return <CreateAgentPanel {...sharedProps} />
      case 'model':
        return <CreateModelPanel {...sharedProps} />
    }
  })()

  return (
    <Suspense
      key={renderedRequest.id}
      fallback={<LoadingPanel request={renderedRequest} open={open} onClose={closeCreateItem} />}
    >
      {panel}
    </Suspense>
  )
}
