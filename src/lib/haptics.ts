import { impactFeedback, notificationFeedback, selectionFeedback } from '@tauri-apps/plugin-haptics'
import { isMobile, isTauri } from './platform'

type ImpactFeedbackStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'
type NotificationFeedbackType = 'success' | 'warning' | 'error'

/**
 * Triggers selection haptic feedback (light bump).
 * Tauri mobile only — web uses useWebHaptics from web-haptics/react.
 */
export const triggerSelection = async (): Promise<void> => {
  if (!isTauri() || !isMobile()) {
    return
  }
  await selectionFeedback()
}

/**
 * Triggers impact haptic feedback.
 * Tauri mobile only — web uses useWebHaptics from web-haptics/react.
 */
export const triggerImpact = async (style: ImpactFeedbackStyle = 'light'): Promise<void> => {
  if (!isTauri() || !isMobile()) {
    return
  }
  await impactFeedback(style)
}

/**
 * Triggers notification haptic feedback (success, warning, error).
 * Tauri mobile only — web uses useWebHaptics from web-haptics/react.
 */
export const triggerNotification = async (type: NotificationFeedbackType): Promise<void> => {
  if (!isTauri() || !isMobile()) {
    return
  }
  await notificationFeedback(type)
}
