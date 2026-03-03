import { useWebHaptics } from 'web-haptics/react'
import { useIsMobile } from '@/hooks/use-mobile'

type HapticsPreset = 'selection' | 'light' | 'medium'

export type UseHapticsResult = {
  triggerSelection: () => void
  triggerLight: () => void
  triggerMedium: () => void
  isAvailable: boolean
}

/**
 * Thin wrapper around useWebHaptics that gates haptics on mobile viewport + Vibration API.
 * No-ops when unavailable (desktop, or navigator.vibrate absent).
 */
export const useHaptics = (): UseHapticsResult => {
  const { isMobile } = useIsMobile()
  const { trigger, isSupported } = useWebHaptics()

  const isAvailable = isMobile && isSupported

  const triggerPreset = (preset: HapticsPreset) => {
    if (!isAvailable) return
    try {
      trigger(preset)
    } catch {
      // Fire-and-forget; never block UI
    }
  }

  return {
    triggerSelection: () => triggerPreset('selection'),
    triggerLight: () => triggerPreset('light'),
    triggerMedium: () => triggerPreset('medium'),
    isAvailable,
  }
}
