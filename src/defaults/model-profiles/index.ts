import { hashValues } from '@/lib/utils'
import type { ModelProfile } from '@/types'
import { defaultModelProfileGptOss120b } from './gpt-oss'
import { defaultModelProfileMistralMedium31 } from './mistral'
import { defaultModelProfileSonnet45 } from './sonnet'

export { defaultModelProfileGptOss120b } from './gpt-oss'
export { defaultModelProfileMistralMedium31 } from './mistral'
export { defaultModelProfileSonnet45 } from './sonnet'

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
  defaultModelProfileMistralMedium31,
  defaultModelProfileSonnet45,
] as const
