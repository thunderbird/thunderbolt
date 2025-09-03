/**
 * This component provides a clean way to feature-gate UI elements based on
 * user's settings. They automatically check if the user
 * has enabled experimental features and conditionally render content.
 */

import { useBooleanSetting } from '@/hooks/use-setting'
import { ReactNode } from 'react'

interface ExperimentalFeatureWrapperProps {
  children: ReactNode
  settingKey: string
}

export function ExperimentalFeatureWrapper({ children, settingKey }: ExperimentalFeatureWrapperProps) {
  const [experimentalFeaturesEnabled] = useBooleanSetting(settingKey, false)

  if (!experimentalFeaturesEnabled) {
    return null
  }

  return children
}
