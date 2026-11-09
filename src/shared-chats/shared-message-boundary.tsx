/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Component, type ErrorInfo, type ReactNode } from 'react'

type SharedMessageBoundaryProps = { children: ReactNode }

type SharedMessageBoundaryState = { hasFailed: boolean }

/**
 * Contains a message of a shared chat that fails to render. The snapshot is
 * another account's data: a widget entry or part shaped in a way the parser
 * let through but a component cannot draw must cost that one message, not the
 * whole transcript. A class because React has no hook for catching render
 * errors.
 */
export class SharedMessageBoundary extends Component<SharedMessageBoundaryProps, SharedMessageBoundaryState> {
  state: SharedMessageBoundaryState = { hasFailed: false }

  static getDerivedStateFromError = (): SharedMessageBoundaryState => ({ hasFailed: true })

  componentDidCatch = (error: Error, info: ErrorInfo) => {
    console.error('A shared chat message failed to render', error, info.componentStack)
  }

  render = () =>
    this.state.hasFailed ? (
      <p className="my-4 text-[length:var(--font-size-sm)] text-muted-foreground">
        <Trans>This message can’t be shown.</Trans>
      </p>
    ) : (
      this.props.children
    )
}
