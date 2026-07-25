/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Loader2 } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import { type CreateItemRequest, useCreateItem } from './context'
import { CreateItemPanelShell } from './create-item-panel-shell'

const CreateSkillPanel = lazy(() =>
  import('./create-skill-panel').then((module) => ({ default: module.CreateSkillPanel })),
)
const CreateAgentPanel = lazy(() =>
  import('./create-agent-panel').then((module) => ({ default: module.CreateAgentPanel })),
)
const CreateModelPanel = lazy(() =>
  import('./create-model-panel').then((module) => ({ default: module.CreateModelPanel })),
)

const LoadingPanel = ({
  request,
  open,
  onClose,
  onCloseComplete,
}: {
  request: CreateItemRequest
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
}) => (
  <CreateItemPanelShell kind={request.kind} open={open} onClose={onClose} onCloseComplete={onCloseComplete}>
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="size-[var(--icon-size-default)] animate-spin text-muted-foreground" />
    </div>
  </CreateItemPanelShell>
)

/**
 * Keeps the last request mounted while its surface animates closed. A new
 * request id remounts its form so reopening always starts clean.
 */
export const CreateItemHost = () => {
  const { request, isSurfaceOpen, closeCreateItem } = useCreateItem()
  const [renderedRequest, setRenderedRequest] = useState<CreateItemRequest | null>(request)

  if (request && request.id !== renderedRequest?.id) {
    setRenderedRequest(request)
  }

  if (!renderedRequest) {
    return null
  }

  const handleCloseComplete = () => {
    if (!request) {
      setRenderedRequest(null)
    }
  }

  // The provider clears `isSurfaceOpen` in the same update as any request
  // change, so it alone means "the rendered request is open".
  const sharedProps = { open: isSurfaceOpen, onClose: closeCreateItem, onCloseComplete: handleCloseComplete }

  const panel = (() => {
    switch (renderedRequest.kind) {
      case 'skill':
        return <CreateSkillPanel {...sharedProps} initialName={renderedRequest.initialName} />
      case 'agent':
        return <CreateAgentPanel {...sharedProps} />
      case 'model':
        return <CreateModelPanel {...sharedProps} />
      default:
        throw new Error(`Unhandled create-item kind: ${JSON.stringify(renderedRequest satisfies never)}`)
    }
  })()

  return (
    <Suspense
      key={renderedRequest.id}
      fallback={
        <LoadingPanel
          request={renderedRequest}
          open={isSurfaceOpen}
          onClose={closeCreateItem}
          onCloseComplete={handleCloseComplete}
        />
      }
    >
      {panel}
    </Suspense>
  )
}
