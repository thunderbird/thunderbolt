/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import type { ModelProfile } from '@/types'
import { defaultModelProfileGptOss120b } from './gpt-oss'
import { defaultModelProfileOpus47 } from './opus'
import { defaultModelProfileTinfoil } from './tinfoil'

export { defaultModelProfileGptOss120b } from './gpt-oss'
export { defaultModelProfileOpus47 } from './opus'
export { defaultModelProfileTinfoil } from './tinfoil'

/**
 * Compute hash of user-editable fields for a model profile.
 * Includes deletedAt to treat soft-delete as a user configuration choice.
 * Excludes modelId (PK) and defaultHash (the hash itself).
 */
export const hashModelProfile = (profile: ModelProfile): string =>
  hashValues([
    profile.temperature,
    profile.maxSteps,
    profile.maxAttempts,
    profile.nudgeThreshold,
    profile.useSystemMessageModeDeveloper,
    profile.toolsOverride,
    profile.linkPreviewsOverride,
    profile.chatModeAddendum,
    profile.searchModeAddendum,
    profile.researchModeAddendum,
    profile.citationReinforcementEnabled,
    profile.citationReinforcementPrompt,
    profile.nudgeFinalStep,
    profile.nudgePreventive,
    profile.nudgeRetry,
    profile.nudgeSearchFinalStep,
    profile.nudgeSearchPreventive,
    profile.nudgeSearchRetry,
    profile.providerOptions ? JSON.stringify(profile.providerOptions) : null,
    profile.deletedAt,
  ])

/** All default model profiles for iteration */
export const defaultModelProfiles: ReadonlyArray<ModelProfile> = [
  defaultModelProfileGptOss120b,
  defaultModelProfileOpus47,
  defaultModelProfileTinfoil,
] as const
