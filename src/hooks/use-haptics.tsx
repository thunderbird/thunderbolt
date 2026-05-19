/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, type ReactNode, useCallback, useContext } from 'react'
import { useWebHaptics } from 'web-haptics/react'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import {
  triggerImpact,
  triggerNotification,
  triggerSelection,
  type ImpactFeedbackStyle,
  type NotificationFeedbackType,
} from '@/lib/haptics'
import { isMobile, isTauri } from '@/lib/platform'

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
  const hapticsEnabled = useLocalSettingsStore((s) => s.hapticsEnabled)
  const { trigger } = useWebHaptics({ debug: import.meta.env.DEV })

  const triggerSelectionHaptic = useCallback(() => {
    if (!hapticsEnabled) {
      return
    }
    if (isTauri() && isMobile()) {
      void triggerSelection()
    } else {
      void trigger('selection')
    }
  }, [hapticsEnabled, trigger])

  const triggerImpactHaptic = useCallback(
    (style: ImpactFeedbackStyle = 'light') => {
      if (!hapticsEnabled) {
        return
      }
      if (isTauri() && isMobile()) {
        void triggerImpact(style)
      } else {
        void trigger(style)
      }
    },
    [hapticsEnabled, trigger],
  )

  const triggerNotificationHaptic = useCallback(
    (type: NotificationFeedbackType) => {
      if (!hapticsEnabled) {
        return
      }
      if (isTauri() && isMobile()) {
        void triggerNotification(type)
      } else {
        void trigger(type)
      }
    },
    [hapticsEnabled, trigger],
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
