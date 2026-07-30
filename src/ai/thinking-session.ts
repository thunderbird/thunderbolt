/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'

/**
 * True when the selected model advertises thinking and the conversation chip
 * has turned it off for this send.
 */
export const isThinkingDisabledForSend = (
  model: Pick<Model, 'startWithReasoning'>,
  thinkingEnabled: boolean | undefined,
): boolean => model.startWithReasoning === 1 && thinkingEnabled === false

/**
 * Returns a model view with thinking forced off for this send when the chip
 * disabled it. Does not mutate the stored model row (capability stays on so
 * the composer chip remains visible).
 */
export const withThinkingDisabledForSend = <T extends Pick<Model, 'startWithReasoning'>>(
  model: T,
  thinkingEnabled: boolean | undefined,
): T => {
  if (!isThinkingDisabledForSend(model, thinkingEnabled)) {
    return model
  }
  return { ...model, startWithReasoning: 0 }
}

/**
 * OpenAI-compat provider options for the Thinking chip. Chip off asks the
 * endpoint (incl. Ollama) for no reasoning effort on this send.
 */
export const openaiCompatThinkingProviderOptions = (
  thinkingDisabled: boolean,
): { reasoningEffort: 'none' } | Record<string, never> => (thinkingDisabled ? { reasoningEffort: 'none' } : {})
