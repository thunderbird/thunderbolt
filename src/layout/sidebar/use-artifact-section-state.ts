/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { usePinnedArtifacts } from '@/artifacts/use-artifacts'
import { artifactPath } from '@/artifacts/artifact'
import { useSidebarPreviewState } from './use-sidebar-preview-state'

/** Share the pin preview and disclosure state between the expanded section and icon rail. */
export const useArtifactSectionState = (pathname: string) => {
  const { artifacts, loading, failed } = usePinnedArtifacts()
  const [expanded, setExpanded] = useState(true)
  const activeId = artifacts.find((artifact) => artifactPath(artifact.id) === pathname)?.id
  const preview = useSidebarPreviewState(artifacts, activeId)
  return {
    artifacts,
    loading,
    failed,
    activeId,
    preview,
    expanded,
    toggle: () => setExpanded((value) => !value),
  }
}
