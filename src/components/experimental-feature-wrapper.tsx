/**
 * This component provides a clean way to feature-gate UI elements based on
 * the experimental_features setting. They automatically check if the user
 * has enabled experimental features and conditionally render content.
 */

import { useBooleanSetting } from '@/hooks/use-setting'
import { ReactNode } from 'react'

interface ExperimentalFeatureWrapperProps {
  children: ReactNode
}

export function ExperimentalFeatureWrapper({ children }: ExperimentalFeatureWrapperProps) {
  const [experimentalFeaturesEnabled] = useBooleanSetting('experimental_features', false)

  if (!experimentalFeaturesEnabled) {
    return null
  }

  return children
}
