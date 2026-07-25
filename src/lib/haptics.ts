/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { impactFeedback, notificationFeedback, selectionFeedback } from '@tauri-apps/plugin-haptics'

export type ImpactFeedbackStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'
export type NotificationFeedbackType = 'success' | 'warning' | 'error'

/** Window in which a surface (modal/drawer) lifecycle haptic is suppressed
 *  after any other haptic — sized to one perceptual UI transition (matches
 *  the longest surface open/close animation) so a tap that opens a surface
 *  produces one tap, not two. */
export const surfaceHapticDeduplicationMs = 500

/**
 * Returns whether a modal or drawer lifecycle should emit its own haptic.
 * Suppresses lifecycle feedback shortly after any other haptic so one
 * interaction does not produce multiple taps.
 */
export const shouldTriggerSurfaceHaptic = (lastHapticAt: number | null, now: number) =>
  lastHapticAt === null || now - lastHapticAt >= surfaceHapticDeduplicationMs

/**
 * Thin wrappers around @tauri-apps/plugin-haptics.
 * Callers (HapticsProvider) are responsible for platform checks.
 */
export const triggerSelection = () => selectionFeedback()
export const triggerImpact = (style: ImpactFeedbackStyle = 'light') => impactFeedback(style)
export const triggerNotification = (type: NotificationFeedbackType) => notificationFeedback(type)
