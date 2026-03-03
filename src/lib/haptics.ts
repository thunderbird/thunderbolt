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
  try {
    const { selectionFeedback } = await import('@tauri-apps/plugin-haptics')
    await selectionFeedback()
  } catch {
    // Plugin not available (e.g. web build)
  }
}

/**
 * Triggers impact haptic feedback.
 * Tauri mobile only — web uses useWebHaptics from web-haptics/react.
 */
export const triggerImpact = async (style: ImpactFeedbackStyle = 'light'): Promise<void> => {
  if (!isTauri() || !isMobile()) {
    return
  }
  try {
    const { impactFeedback } = await import('@tauri-apps/plugin-haptics')
    await impactFeedback(style)
  } catch {
    // Plugin not available (e.g. web build)
  }
}

/**
 * Triggers notification haptic feedback (success, warning, error).
 * Tauri mobile only — web uses useWebHaptics from web-haptics/react.
 */
export const triggerNotification = async (type: NotificationFeedbackType): Promise<void> => {
  if (!isTauri() || !isMobile()) {
    return
  }
  try {
    const { notificationFeedback } = await import('@tauri-apps/plugin-haptics')
    await notificationFeedback(type)
  } catch {
    // Plugin not available (e.g. web build)
  }
}
