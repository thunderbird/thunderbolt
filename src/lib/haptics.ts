import { WebHaptics } from 'web-haptics'
import { isMobile, isTauri } from './platform'

type ImpactFeedbackStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'
type NotificationFeedbackType = 'success' | 'warning' | 'error'

let webHapticsInstance: WebHaptics | null = null

const getWebHaptics = (): WebHaptics | null => {
  if (typeof window === 'undefined') {
    return null
  }
  if (!WebHaptics.isSupported) {
    return null
  }
  if (!webHapticsInstance) {
    webHapticsInstance = new WebHaptics()
  }
  return webHapticsInstance
}

const isHapticsCapable = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  if (isTauri() && isMobile()) {
    return true
  }
  return WebHaptics.isSupported
}

/**
 * Triggers selection haptic feedback (light bump).
 * No-op on desktop or when haptics are not supported.
 */
export const triggerSelection = async (): Promise<void> => {
  if (!isHapticsCapable()) {
    return
  }

  if (isTauri() && isMobile()) {
    try {
      const { selectionFeedback } = await import('@tauri-apps/plugin-haptics')
      await selectionFeedback()
    } catch {
      // Plugin not available (e.g. web build)
    }
    return
  }

  const webHaptics = getWebHaptics()
  if (webHaptics) {
    console.log('DEBUG: triggering selection haptic')
    await webHaptics.trigger('selection')
  }
}

/**
 * Triggers impact haptic feedback.
 * No-op on desktop or when haptics are not supported.
 */
export const triggerImpact = async (style: ImpactFeedbackStyle = 'light'): Promise<void> => {
  if (!isHapticsCapable()) {
    return
  }

  if (isTauri() && isMobile()) {
    try {
      const { impactFeedback } = await import('@tauri-apps/plugin-haptics')
      await impactFeedback(style)
    } catch {
      // Plugin not available (e.g. web build)
    }
    return
  }

  const webHaptics = getWebHaptics()
  if (webHaptics) {
    await webHaptics.trigger(style)
  }
}

/**
 * Triggers notification haptic feedback (success, warning, error).
 * No-op on desktop or when haptics are not supported.
 */
export const triggerNotification = async (type: NotificationFeedbackType): Promise<void> => {
  if (!isHapticsCapable()) {
    return
  }

  if (isTauri() && isMobile()) {
    try {
      const { notificationFeedback } = await import('@tauri-apps/plugin-haptics')
      await notificationFeedback(type)
    } catch {
      // Plugin not available (e.g. web build)
    }
    return
  }

  const webHaptics = getWebHaptics()
  if (webHaptics) {
    await webHaptics.trigger(type)
  }
}
