import { useBooleanSetting } from '@/hooks/use-setting'
import { ReactNode } from 'react'
import { Navigate } from 'react-router'

type ExperimentalFeatureRouteWrapperProps = {
  children: ReactNode
  settingKey: string
}

export function ExperimentalFeatureRouteWrapper({ children, settingKey }: ExperimentalFeatureRouteWrapperProps) {
  const [experimentalFeaturesEnabled] = useBooleanSetting(settingKey, false)

  if (!experimentalFeaturesEnabled) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
