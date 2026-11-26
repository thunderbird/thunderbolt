/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Component, type ReactNode } from 'react'

type ViewerErrorBoundaryProps = {
  fallback: ReactNode
  children: ReactNode
}

type ViewerErrorBoundaryState = { failed: boolean }

/**
 * Shows `fallback` in place of a side view viewer that throws, most often because its lazy chunk did not load on a
 * broken network. The failure stays in the panel and the rest of the app keeps running. Key it by file and attempt, so
 * the next file and Try again start fresh. It is a class because React has no hook for catching render errors.
 */
export class ViewerErrorBoundary extends Component<ViewerErrorBoundaryProps, ViewerErrorBoundaryState> {
  state: ViewerErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ViewerErrorBoundaryState {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
