/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ModelProfile } from '@/types'
import { defaultModelOpus5 } from '@shared/defaults/models'

export const defaultModelProfileOpus5: ModelProfile = {
  modelId: defaultModelOpus5.id,
  temperature: null,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
  useSystemMessageModeDeveloper: 0,
  providerOptions: null,
  toolsOverride: `• For a narrow current-fact lookup, use an official source for the requested value and the fact's own date or observation time; fetch a page if that evidence is missing. If a volatile value still has no observation time, attribute it to the source, label any publication date as such (or say "source undated"), and state "observation time unavailable; not a live quote". Never substitute today's date or call that value current; if the requested fact itself is missing, state the gap instead of filling it from memory.`,
  linkPreviewsOverride: null,
  chatModeAddendum: null,
  searchModeAddendum: null,
  researchModeAddendum: null,
  citationReinforcementEnabled: 0,
  citationReinforcementPrompt: null,
  nudgeFinalStep: null,
  nudgePreventive: null,
  nudgeRetry: null,
  nudgeSearchFinalStep: null,
  nudgeSearchPreventive: null,
  nudgeSearchRetry: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}
