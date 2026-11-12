/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocation, useNavigate } from 'react-router'
import { lazy, Suspense, useState } from 'react'

import { createItemTitle, type CreateItemRequest, useCreateItem } from './context'
import { CreateItemLoadingPanel } from './create-item-panel-shell'

const CreateSkillPanel = lazy(() =>
  import('./create-skill-panel').then((module) => ({ default: module.CreateSkillPanel })),
)
const CreateAgentPanel = lazy(() =>
  import('./create-agent-panel').then((module) => ({ default: module.CreateAgentPanel })),
)
const CreateModelPanel = lazy(() =>
  import('./create-model-panel').then((module) => ({ default: module.CreateModelPanel })),
)

const CreateConnectionPanel = lazy(() =>
  import('@/settings/connections').then((module) => ({ default: module.CreateConnectionPanel })),
)

/**
 * Keeps the last request mounted while its surface animates closed. A new
 * request id remounts its form so reopening always starts clean.
 */
export const CreateItemHost = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { request, isSurfaceOpen, closeCreateItem } = useCreateItem()
  const [renderedRequest, setRenderedRequest] = useState<CreateItemRequest | null>(request)

  if (request && request.id !== renderedRequest?.id) {
    setRenderedRequest(request)
  }

  // Callback state owns this surface until it is dismissed; no redirect to Settings is needed.
  if (location.state?.connectionOAuthReturn && location.pathname !== '/settings/connections') {
    const close = () => {
      closeCreateItem()
      navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null })
    }
    return (
      <Suspense
        fallback={
          <CreateItemLoadingPanel
            kind="connection"
            title={createItemTitle({ kind: 'connection', id: 0 })}
            open
            onClose={close}
            onCloseComplete={() => {}}
          />
        }
      >
        <CreateConnectionPanel
          key={location.state.connectionOAuthReturn}
          open
          onClose={close}
          onCloseComplete={() => {}}
        />
      </Suspense>
    )
  }

  if (!renderedRequest) {
    return null
  }

  const handleCloseComplete = () => {
    if (!request) {
      setRenderedRequest(null)
    }
  }
  const closeRequest = () => closeCreateItem(renderedRequest.id)

  // The provider clears `isSurfaceOpen` in the same update as any request
  // change, so it alone means "the rendered request is open".
  const sharedProps = { open: isSurfaceOpen, onClose: closeRequest, onCloseComplete: handleCloseComplete }

  const panel = (() => {
    switch (renderedRequest.kind) {
      case 'skill':
        return (
          <CreateSkillPanel
            {...sharedProps}
            initialName={renderedRequest.initialName}
            skillId={renderedRequest.skillId}
          />
        )
      case 'agent':
        return <CreateAgentPanel {...sharedProps} />
      case 'connection':
        return (
          <CreateConnectionPanel
            {...sharedProps}
            connectionId={renderedRequest.connectionId}
            initialAction={renderedRequest.action}
          />
        )
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
        <CreateItemLoadingPanel
          kind={renderedRequest.kind}
          title={createItemTitle(renderedRequest)}
          open={isSurfaceOpen}
          onClose={closeRequest}
          onCloseComplete={handleCloseComplete}
        />
      }
    >
      {panel}
    </Suspense>
  )
}
