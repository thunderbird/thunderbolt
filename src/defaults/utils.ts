/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashPrompt } from './automations'
import { hashModel } from '@shared/defaults/models'
import { defaultSettings, hashSetting } from './settings'
import type { Model, Prompt, Setting } from '@/types'

/**
 * Check if a model has been modified from its default
 */
export const isModelModified = (model: Model): boolean => {
  if (!model.defaultHash) {
    return false
  }
  const currentHash = hashModel(model)
  return currentHash !== model.defaultHash
}

/**
 * Check if an automation has been modified from its default
 */
export const isAutomationModified = (prompt: Prompt): boolean => {
  if (!prompt.defaultHash) {
    return false
  }
  const currentHash = hashPrompt(prompt)
  return currentHash !== prompt.defaultHash
}

const nullValuedDefaultKeys = new Set(defaultSettings.filter((s) => s.value === null).map((s) => s.key))

/**
 * Check if a setting has been modified from its default
 *
 * Normally that is a hash comparison against the stamp reconcile wrote when it
 * seeded the row. Null-valued defaults have no seeded row to stamp — reconcile
 * deliberately leaves them absent so the first write is an INSERT (see the
 * null-default branch in `reconcileDefaultsForTable`) — so a row for one of
 * those keys with no stamp was created by whoever filled it in. A value there
 * is by definition a departure from the shipped `null`.
 *
 * Writes that mean "still a default" (the browser-language and region-unit
 * seeds) pass `recomputeHash`, so they carry a stamp and fall through to the
 * comparison below, which correctly reports them unmodified.
 */
export const isSettingModified = (setting: Setting | undefined): boolean => {
  if (!setting) {
    return false
  }
  if (!setting.defaultHash) {
    return nullValuedDefaultKeys.has(setting.key) && setting.value !== null
  }
  const currentHash = hashSetting(setting)
  return currentHash !== setting.defaultHash
}
