import { useBooleanSetting } from '@/hooks/use-setting'
import { ReactNode } from 'react'
import { Navigate } from 'react-router'

export function ExperimentalFeatureRouteWrapper({
  children,
  fallback = null,
}: {
  children: ReactNode
  fallback?: ReactNode
}) {
  const [experimentalFeaturesEnabled] = useBooleanSetting('experimental_features', false)

  if (!experimentalFeaturesEnabled) {
    return fallback || <Navigate to="/" replace />
  }

  return <>{children}</>
}
