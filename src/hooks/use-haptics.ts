import { useCallback } from 'react'
import { useSettings } from './use-settings'
import { triggerImpact, triggerNotification, triggerSelection } from '@/lib/haptics'

type ImpactFeedbackStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'
type NotificationFeedbackType = 'success' | 'warning' | 'error'

const isHapticsEnabled = (value: boolean): boolean => value === true

/**
 * Hook that returns haptic trigger functions.
 * Triggers only fire when the haptics_enabled setting is true.
 */
export const useHaptics = () => {
  const { hapticsEnabled } = useSettings({ haptics_enabled: true })

  const triggerSelectionHaptic = useCallback(() => {
    if (!isHapticsEnabled(hapticsEnabled.value)) {
      return
    }
    void triggerSelection()
  }, [hapticsEnabled.value])

  const triggerImpactHaptic = useCallback(
    (style: ImpactFeedbackStyle = 'light') => {
      if (!isHapticsEnabled(hapticsEnabled.value)) {
        return
      }
      void triggerImpact(style)
    },
    [hapticsEnabled.value],
  )

  const triggerNotificationHaptic = useCallback(
    (type: NotificationFeedbackType) => {
      if (!isHapticsEnabled(hapticsEnabled.value)) {
        return
      }
      void triggerNotification(type)
    },
    [hapticsEnabled.value],
  )

  return {
    triggerSelection: triggerSelectionHaptic,
    triggerImpact: triggerImpactHaptic,
    triggerNotification: triggerNotificationHaptic,
  }
}
