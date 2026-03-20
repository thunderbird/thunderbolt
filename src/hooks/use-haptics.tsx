import { createContext, type ReactNode, useCallback, useContext } from 'react'
import { useWebHaptics } from 'web-haptics/react'
import { useSettings } from './use-settings'
import {
  triggerImpact,
  triggerNotification,
  type ImpactFeedbackStyle,
  type NotificationFeedbackType,
} from '@/lib/haptics'
import { isMobile, isTauri } from '@/lib/platform'

/** Shift each Tauri impact style up one notch for stronger native feedback */
const tauriImpactBoost: Record<ImpactFeedbackStyle, ImpactFeedbackStyle> = {
  soft: 'light',
  light: 'medium',
  medium: 'heavy',
  heavy: 'rigid',
  rigid: 'rigid',
}

type HapticsContextValue = {
  triggerSelection: () => void
  triggerImpact: (style?: ImpactFeedbackStyle) => void
  triggerNotification: (type: NotificationFeedbackType) => void
}

const noop = () => {}

const HapticsContext = createContext<HapticsContextValue>({
  triggerSelection: noop,
  triggerImpact: noop,
  triggerNotification: noop,
})

/**
 * Provider that wires haptics to the database settings and platform APIs.
 * Wrap this around your app tree. Components using useHaptics() without
 * a provider get silent no-ops, keeping them usable as dumb components.
 */
export const HapticsProvider = ({ children }: { children: ReactNode }) => {
  const { hapticsEnabled } = useSettings({ haptics_enabled: true })
  const { trigger } = useWebHaptics({ debug: import.meta.env.DEV })
  const enabled = hapticsEnabled.value === true

  const triggerSelectionHaptic = useCallback(() => {
    if (!enabled) {
      return
    }
    if (isTauri() && isMobile()) {
      // Use impact('light') instead of selectionFeedback for stronger native haptics
      void triggerImpact('light')
    } else {
      void trigger('selection')
    }
  }, [enabled, trigger])

  const triggerImpactHaptic = useCallback(
    (style: ImpactFeedbackStyle = 'light') => {
      if (!enabled) {
        return
      }
      if (isTauri() && isMobile()) {
        void triggerImpact(tauriImpactBoost[style])
      } else {
        void trigger(style)
      }
    },
    [enabled, trigger],
  )

  const triggerNotificationHaptic = useCallback(
    (type: NotificationFeedbackType) => {
      if (!enabled) {
        return
      }
      if (isTauri() && isMobile()) {
        void triggerNotification(type)
      } else {
        void trigger(type)
      }
    },
    [enabled, trigger],
  )

  return (
    <HapticsContext.Provider
      value={{
        triggerSelection: triggerSelectionHaptic,
        triggerImpact: triggerImpactHaptic,
        triggerNotification: triggerNotificationHaptic,
      }}
    >
      {children}
    </HapticsContext.Provider>
  )
}

/**
 * Returns haptic trigger functions from the nearest HapticsProvider.
 * If no provider exists, returns silent no-ops — safe for dumb components.
 */
export const useHaptics = () => useContext(HapticsContext)
