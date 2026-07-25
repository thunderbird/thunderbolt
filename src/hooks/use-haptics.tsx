/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
} from 'react'
import { useWebHaptics } from 'web-haptics/react'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import {
  triggerImpact,
  triggerNotification,
  triggerSelection,
  shouldTriggerSurfaceHaptic,
  type ImpactFeedbackStyle,
  type NotificationFeedbackType,
} from '@/lib/haptics'
import { isMobile, isTauri } from '@/lib/platform'

type HapticsContextValue = {
  triggerSelection: () => void
  triggerImpact: (style?: ImpactFeedbackStyle) => void
  triggerNotification: (type: NotificationFeedbackType) => void
  triggerSurfaceImpact: () => void
}

const noop = () => {}

const HapticsContext = createContext<HapticsContextValue>({
  triggerSelection: noop,
  triggerImpact: noop,
  triggerNotification: noop,
  triggerSurfaceImpact: noop,
})

/**
 * Provider that wires haptics to the database settings and platform APIs.
 * Wrap this around your app tree. Components using useHaptics() without
 * a provider get silent no-ops, keeping them usable as dumb components.
 */
export const HapticsProvider = ({ children }: { children: ReactNode }) => {
  const hapticsEnabled = useLocalSettingsStore((s) => s.hapticsEnabled)
  const { trigger } = useWebHaptics({ debug: import.meta.env.DEV })
  const lastHapticAtRef = useRef<number | null>(null)

  // Every haptic funnels through here so the enabled gate, the dedup
  // timestamp, and the native-vs-web routing are decided exactly once.
  const fireHaptic = useCallback(
    (triggerNative: () => Promise<unknown>, triggerWeb: () => unknown) => {
      if (!hapticsEnabled) {
        return
      }
      lastHapticAtRef.current = Date.now()
      const trigger = isTauri() && isMobile() ? triggerNative : triggerWeb
      // Haptics are best-effort; a failing call must not surface as an
      // unhandled rejection, but should still be visible in dev.
      void Promise.resolve(trigger()).catch((error: unknown) => console.warn('Haptic feedback failed', error))
    },
    [hapticsEnabled],
  )

  const triggerSelectionHaptic = useCallback(
    () => fireHaptic(triggerSelection, () => trigger('selection')),
    [fireHaptic, trigger],
  )

  const triggerImpactHaptic = useCallback(
    (style: ImpactFeedbackStyle = 'light') =>
      fireHaptic(
        () => triggerImpact(style),
        () => trigger(style),
      ),
    [fireHaptic, trigger],
  )

  const triggerNotificationHaptic = useCallback(
    (type: NotificationFeedbackType) =>
      fireHaptic(
        () => triggerNotification(type),
        () => trigger(type),
      ),
    [fireHaptic, trigger],
  )

  // The enabled gate lives in fireHaptic; this only adds the dedup window.
  const triggerSurfaceImpactHaptic = useCallback(() => {
    if (!shouldTriggerSurfaceHaptic(lastHapticAtRef.current, Date.now())) {
      return
    }
    triggerImpactHaptic()
  }, [triggerImpactHaptic])

  // Memoized so app-shell re-renders don't invalidate every consumer (chat
  // composer, sidebar, and surface boundaries all read this context).
  const value = useMemo(
    () => ({
      triggerSelection: triggerSelectionHaptic,
      triggerImpact: triggerImpactHaptic,
      triggerNotification: triggerNotificationHaptic,
      triggerSurfaceImpact: triggerSurfaceImpactHaptic,
    }),
    [triggerSelectionHaptic, triggerImpactHaptic, triggerNotificationHaptic, triggerSurfaceImpactHaptic],
  )

  return <HapticsContext.Provider value={value}>{children}</HapticsContext.Provider>
}

/**
 * Returns haptic trigger functions from the nearest HapticsProvider.
 * If no provider exists, returns silent no-ops — safe for dumb components.
 */
export const useHaptics = () => useContext(HapticsContext)

/**
 * Requests a light impact when the calling component mounts and unmounts.
 * Placed inside a modal/drawer's portal or presence boundary, this covers
 * opens and closes from taps, swipes, Escape, and programmatic changes.
 * The provider suppresses requests that immediately follow another haptic.
 */
const useMountHaptic = () => {
  const { triggerSurfaceImpact } = useHaptics()
  // Effect event so the mount/unmount taps always use the provider's current
  // trigger (it re-binds when the user toggles haptics) without re-running
  // the effect — a settings toggle mid-open must not fire phantom taps.
  const tap = useEffectEvent(() => triggerSurfaceImpact())
  useEffect(() => {
    tap()
    return () => tap()
  }, [])
}

/**
 * Adds open and close haptics to a conditionally mounted surface.
 * Render this inside the surface's portal or presence boundary.
 */
export const HapticMountBoundary = () => {
  useMountHaptic()
  return null
}
