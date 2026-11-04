/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import './browser-stubs/install-process.ts'
import { hasApi, getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models'
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models'
import { isReasoningEffort, noReasoningEffort, type ReasoningCapabilities } from '../reasoning-effort.ts'

/** Advertise distinct Pi controls only; exclude aliases that silently select another effort. */
export const piReasoningCapabilities = (model: Model<Api> | undefined): ReasoningCapabilities => {
  if (!model?.reasoning) {
    return noReasoningEffort
  }
  if (hasApi(model, 'anthropic-messages') && model.compat?.forceAdaptiveThinking !== true) {
    return { kind: 'toggle', efforts: ['none', 'high'] }
  }
  return {
    efforts: getSupportedThinkingLevels(model).flatMap((level) => {
      const mapped = model.thinkingLevelMap?.[level]
      if (level === 'off') {
        return mapped === 'none' || model.api === 'anthropic-messages' ? ['none' as const] : []
      }
      return isReasoningEffort(level) && (mapped === undefined || mapped === level) ? [level] : []
    }),
  }
}

/** Lazy catalog lookup: keep Pi and its providers out of the composer's entry bundle. */
export const catalogReasoningCapabilities = (provider: string, modelId: string): ReasoningCapabilities => {
  const catalog: Readonly<Record<string, Model<Api>>> =
    provider === 'openai' ? OPENAI_MODELS : provider === 'anthropic' ? ANTHROPIC_MODELS : {}
  return piReasoningCapabilities(Object.hasOwn(catalog, modelId) ? catalog[modelId] : undefined)
}
