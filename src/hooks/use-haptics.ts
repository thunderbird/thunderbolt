import { useCallback } from 'react'
import { useWebHaptics } from 'web-haptics/react'
import { useSettings } from './use-settings'
import { triggerImpact, triggerNotification, triggerSelection } from '@/lib/haptics'
import { isMobile, isTauri } from '@/lib/platform'

type ImpactFeedbackStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'
type NotificationFeedbackType = 'success' | 'warning' | 'error'

const isHapticsEnabled = (value: boolean): boolean => value === true

/**
 * Hook that returns haptic trigger functions.
 * Triggers only fire when the haptics_enabled setting is true.
 * Uses WebHaptics (web-haptics/react) for web, Tauri plugin for mobile.
 */
export const useHaptics = () => {
  const { hapticsEnabled } = useSettings({ haptics_enabled: true })
  const { trigger } = useWebHaptics({ debug: import.meta.env.DEV })

  const triggerSelectionHaptic = useCallback(() => {
    if (!isHapticsEnabled(hapticsEnabled.value)) {
      return
    }
    if (isTauri() && isMobile()) {
      void triggerSelection()
    } else {
      void trigger('selection')
    }
  }, [hapticsEnabled.value, trigger])

  const triggerImpactHaptic = useCallback(
    (style: ImpactFeedbackStyle = 'light') => {
      if (!isHapticsEnabled(hapticsEnabled.value)) {
        return
      }
      if (isTauri() && isMobile()) {
        void triggerImpact(style)
      } else {
        void trigger(style)
      }
    },
    [hapticsEnabled.value, trigger],
  )

  const triggerNotificationHaptic = useCallback(
    (type: NotificationFeedbackType) => {
      if (!isHapticsEnabled(hapticsEnabled.value)) {
        return
      }
      if (isTauri() && isMobile()) {
        void triggerNotification(type)
      } else {
        void trigger(type)
      }
    },
    [hapticsEnabled.value, trigger],
  )

  return {
    triggerSelection: triggerSelectionHaptic,
    triggerImpact: triggerImpactHaptic,
    triggerNotification: triggerNotificationHaptic,
  }
}
