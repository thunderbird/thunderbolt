/** Additive text appended to specific sections of the base prompt */
export type PromptOverride = {
  /** Extra text appended after the Tools section */
  tools?: string
  /** Extra text appended after the Link Previews subsection */
  linkPreviews?: string
  /** Extra text appended after the Active Mode section */
  modeAddendum?: string
}

/** Per-vendor overrides, split into global (all modes) and mode-specific */
export type VendorOverrides = {
  global?: PromptOverride
  modes?: Record<string, PromptOverride>
}

/** Identifier for resolving model-specific config (vendor + model layers) */
export type ModelIdentifier = {
  vendor: string | null
  model: string | null
}

/** Partial config used at vendor or model level — merged with defaults */
export type PartialVendorConfig = Partial<VendorConfig>

/** Full inference config — the resolved result after merging defaults → vendor → model */
export type VendorConfig = {
  /** LLM temperature (lower = more deterministic) */
  temperature: number
  /** Maximum tool-calling steps before forcing a response */
  maxSteps: number
  /** Maximum retry attempts after empty responses */
  maxAttempts: number
  /** Number of tool-call steps before the preventive nudge fires. Set to Infinity to disable. */
  nudgeThreshold: number
  /** Extra provider options passed to the AI SDK (e.g. systemMessageMode for OpenAI) */
  providerOptions?: Record<string, unknown>
}
