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
  toolsOverride: `- After applying the verification and explicit-search rules above, answer established lists, historical examples and stable guidance from knowledge when the conclusion does not depend on today's facts, even if the question mentions this year. Do not add a current count, version or status just to justify a search; verify when the requested answer depends on today's status, access, price or version.
- For those knowledge answers, give the requested examples or guidance first, then one explicit sentence saying changeable details may be outdated and offering to check an up-to-date source. Include the knowledge or estimate year and scope when known and relevant; dates attached to individual examples alone are not a freshness caveat.
- For a standalone niche identity or function lookup outside research, verify the entity with one targeted search even if you recall a specific definition; fetch at most one page if needed, then answer from the evidence and state gaps; ask for user context only when it is needed to distinguish the intended entity.
- For current weather or the next five days, load weather, resolve the place, and emit its widget directly in the final response; ask if the place is ambiguous. This completes the request without search or fetch_content.
- For a narrow current-fact lookup, use an official source for the requested value and the fact's own date or observation time; fetch a page if that evidence is missing. If a volatile value still has no observation time, attribute it to the source, label any publication date as such (or say "source undated"), and state "observation time unavailable; not a live quote". Never substitute today's date or call that value current; if the requested fact itself is missing, state the gap instead of filling it from memory.`,
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
