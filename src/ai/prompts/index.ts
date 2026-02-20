/**
 * Three-level prompt config and override resolver: defaults → vendor → model.
 *
 * Overrides are ADDITIVE — they append text to the corresponding section
 * of the base prompt. They never replace the global prompt content.
 *
 * Only add overrides where E2E testing reveals a measurable deficiency
 * for a specific vendor/model. If all models share the same problem, fix the
 * global prompt instead of adding identical overrides.
 */

import type { ModelIdentifier, PartialVendorConfig, PromptOverride, VendorConfig, VendorOverrides } from './types'
import { defaultVendorConfig } from './vendors/defaults'
import { mistralChatOverride } from './vendors/mistral/chat'
import { mistralGlobalOverride } from './vendors/mistral/global'
import { mistralResearchOverride } from './vendors/mistral/research'
import { mistralSearchOverride } from './vendors/mistral/search'
import { openaiChatOverride } from './vendors/openai/chat'
import { openaiVendorConfig } from './vendors/openai/config'
import { openaiGlobalOverride } from './vendors/openai/global'
import { gptOss120bConfig } from './vendors/openai/models/gpt-oss-120b/config'
import { openaiResearchOverride } from './vendors/openai/research'
import { openaiSearchOverride } from './vendors/openai/search'

/** Vendor-level partial configs — shared by all models from that vendor */
const vendorConfigs: Record<string, PartialVendorConfig> = {
  openai: openaiVendorConfig,
}

/** Model-level partial configs — keyed by vendor then model identifier */
const modelConfigs: Record<string, Record<string, PartialVendorConfig>> = {
  openai: {
    'gpt-oss-120b': gptOss120bConfig,
  },
}

/** Vendor-level prompt overrides */
const vendorOverrides: Record<string, VendorOverrides> = {
  mistral: {
    global: mistralGlobalOverride,
    modes: {
      chat: mistralChatOverride,
      search: mistralSearchOverride,
      research: mistralResearchOverride,
    },
  },
  openai: {
    global: openaiGlobalOverride,
    modes: {
      chat: openaiChatOverride,
      search: openaiSearchOverride,
      research: openaiResearchOverride,
    },
  },
}

/** Model-level prompt overrides — only when a model diverges from its vendor */
const modelOverrides: Record<string, Record<string, VendorOverrides>> = {}

/** Get inference config: defaults → vendor → model */
export const getModelConfig = ({ vendor, model }: ModelIdentifier): VendorConfig => {
  if (!vendor) return defaultVendorConfig

  const vendorCfg = vendorConfigs[vendor]
  const modelCfg = model ? modelConfigs[vendor]?.[model] : undefined

  const mergedProviderOptions =
    vendorCfg?.providerOptions || modelCfg?.providerOptions
      ? { ...vendorCfg?.providerOptions, ...modelCfg?.providerOptions }
      : undefined

  return {
    ...defaultVendorConfig,
    ...vendorCfg,
    ...modelCfg,
    ...(mergedProviderOptions !== undefined && { providerOptions: mergedProviderOptions }),
  }
}

/**
 * Look up prompt overrides for a vendor/model/mode combination.
 * Layers: vendor global → vendor mode → model global → model mode (all concatenated).
 */
export const getPromptOverrides = (
  vendor: string | null,
  model: string | null,
  modeName: string | null,
): PromptOverride | undefined => {
  if (!vendor) return undefined

  const vOverrides = vendorOverrides[vendor]
  const mOverrides = model ? modelOverrides[vendor]?.[model] : undefined

  const layers = [
    vOverrides?.global,
    modeName ? vOverrides?.modes?.[modeName] : undefined,
    mOverrides?.global,
    modeName ? mOverrides?.modes?.[modeName] : undefined,
  ].filter(Boolean) as PromptOverride[]

  if (layers.length === 0) return undefined

  return {
    tools: layers.map((l) => l.tools).filter(Boolean).join('\n') || undefined,
    linkPreviews: layers.map((l) => l.linkPreviews).filter(Boolean).join('\n') || undefined,
    modeAddendum: layers.map((l) => l.modeAddendum).filter(Boolean).join('\n') || undefined,
  }
}
