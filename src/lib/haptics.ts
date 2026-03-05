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
  const { selectionFeedback } = await import('@tauri-apps/plugin-haptics')
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
  const { impactFeedback } = await import('@tauri-apps/plugin-haptics')
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
  const { notificationFeedback } = await import('@tauri-apps/plugin-haptics')
  await notificationFeedback(type)
}
