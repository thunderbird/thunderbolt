/**
 * Global whitelist of Thunderbolt-provided model names (provider-agnostic)
 */
const THUNDERBOLT_MODEL_WHITELIST = new Set([
  'qwen3-235b-a22b-instruct-2507',
  'qwen3-235b-a22b-thinking-2507',
  'kimi-k2-instruct',
  'deepseek-r1-0528',
  'qwen3-235b-a22b',
  'llama-v3p1-405b-instruct',
])

/**
 * Create a model transformer function for a specific provider.
 *
 * @param prefix - The prefix to prepend to whitelisted model names
 * @param checkPrefix - Optional prefix to check if model already has full path
 * @returns A transformer function that processes request bodies
 */
export const createModelTransformer = (prefix: string, checkPrefix?: string) => {
  return (body: Uint8Array): Uint8Array => {
    try {
      // Parse the JSON body
      const bodyText = new TextDecoder().decode(body)
      const data = JSON.parse(bodyText)

      // Check if there's a model field
      if ('model' in data && typeof data.model === 'string') {
        const modelName = data.model

        // Check if model needs transformation
        let shouldTransform = THUNDERBOLT_MODEL_WHITELIST.has(modelName)

        // If checkPrefix is provided, also check that model doesn't already have it
        if (checkPrefix && modelName.startsWith(checkPrefix)) {
          shouldTransform = false
        }

        if (shouldTransform) {
          // Prepend the prefix for whitelisted models
          data.model = `${prefix}${modelName}`
        }
      }

      // Return the modified JSON as bytes
      return new TextEncoder().encode(JSON.stringify(data))
    } catch (error) {
      // If transformation fails, return original body
      console.warn('Model transformation failed:', error)
      return body
    }
  }
}
