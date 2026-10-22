/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useSettings } from '@/hooks/use-settings'
import { readArtifactPins, readSavedArtifactPins, type ProjectArtifact } from './project-artifacts-data'

/** Pins use existing synced settings, with one independent list per project. */
export const useProjectArtifactPins = (projectId: string, artifacts: readonly ProjectArtifact[]) => {
  const { t } = useLingui()
  const key = `project_artifact_pins.${projectId}`
  const settings = useSettings({ [key]: String }, { camelCase: false })
  const setting = settings[key]
  const pinnedIds = readArtifactPins(setting.value, artifacts)
  const [error, setError] = useState<string | null>(null)
  const togglePin = async (id: string) => {
    setError(null)
    const savedIds = readSavedArtifactPins(setting.value)
    const next = savedIds.includes(id) ? savedIds.filter((pin) => pin !== id) : [...savedIds, id]
    try {
      await setting.setValue(JSON.stringify(next))
    } catch (cause) {
      console.error('[projects] Could not save artifact pins', cause)
      setError(t`Could not save the pin. Please try again.`)
    }
  }
  return { pinnedIds, togglePin, error, isSaving: setting.isSaving || setting.isLoading }
}
