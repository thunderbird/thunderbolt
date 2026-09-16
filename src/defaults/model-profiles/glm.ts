/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ModelProfile } from '@/types'
import { defaultModelGlm53 } from '@shared/defaults/models'

export const defaultModelProfileGlm53: ModelProfile = {
  modelId: defaultModelGlm53.id,
  temperature: 0.2,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
  useSystemMessageModeDeveloper: 0,
  providerOptions: { reasoningEffort: 'max' },
  toolsOverride: `• After applying the verification and explicit-search rules above, answer guidance or historical examples from knowledge when the conclusion does not depend on current facts; state the dated scope and possible staleness, and explicitly offer to verify current facts, not merely provide more detail.
• For a standalone narrow question outside research about an unfamiliar or ambiguous entity, verify its exact identity with one targeted search and at most one page fetch if needed; then answer from the evidence, stating any unresolved uncertainty.
• For current weather or the next five days, load the weather skill first and emit its widget directly in the final response for the resolved place; ask if the place is ambiguous. The widget obtains the data without search or fetch_content.
• For narrow current-fact lookups, target the official page containing the requested value and its date; fetch only to fill missing evidence, and do not treat an undated snippet as live.`,
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
