/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { impactFeedback, notificationFeedback, selectionFeedback } from '@tauri-apps/plugin-haptics'

export type ImpactFeedbackStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'
export type NotificationFeedbackType = 'success' | 'warning' | 'error'

/**
 * Thin wrappers around @tauri-apps/plugin-haptics.
 * Callers (HapticsProvider) are responsible for platform checks.
 */
export const triggerSelection = () => selectionFeedback()
export const triggerImpact = (style: ImpactFeedbackStyle = 'light') => impactFeedback(style)
export const triggerNotification = (type: NotificationFeedbackType) => notificationFeedback(type)
