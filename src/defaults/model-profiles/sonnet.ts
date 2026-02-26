import type { ModelProfile } from '@/types'
import { defaultModelSonnet45 } from '@/defaults/models'

export const defaultModelProfileSonnet45: ModelProfile = {
  modelId: defaultModelSonnet45.id,
  temperature: 0.2,
  maxSteps: 20,
  maxAttempts: 2,
  nudgeThreshold: 6,
  useSystemMessageModeDeveloper: 0,
  providerOptions: null,
  toolsOverride: null,
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
