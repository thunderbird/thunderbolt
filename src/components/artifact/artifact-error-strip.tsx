/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AlertTriangle } from 'lucide-react'

/**
 * The runtime-error banner shown when a rendered artifact reports an uncaught
 * error after load. Shared by the inline card and the side-panel view so both
 * surface post-load failures identically.
 */
export const ArtifactErrorStrip = ({ message }: { message: string }) => (
  <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
    <AlertTriangle className="size-3.5 shrink-0" />
    <span className="truncate">{message}</span>
  </div>
)
