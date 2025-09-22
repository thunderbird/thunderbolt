import { describe, expect, it } from 'bun:test'
import { createModelTransformer } from './transformers'

describe('Proxy Transformers', () => {
  describe('createModelTransformer', () => {
    it('should transform whitelisted model names with prefix', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/')
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: 'qwen3-235b-a22b-instruct-2507',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      )

      const result = transformer(body)
      const resultData = JSON.parse(new TextDecoder().decode(result))

      expect(resultData.model).toBe('accounts/fireworks/models/qwen3-235b-a22b-instruct-2507')
      expect(resultData.messages).toEqual([{ role: 'user', content: 'Hello' }])
    })

    it('should not transform non-whitelisted model names', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/')
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      )

      const result = transformer(body)
      const resultData = JSON.parse(new TextDecoder().decode(result))

      expect(resultData.model).toBe('gpt-4') // Unchanged
      expect(resultData.messages).toEqual([{ role: 'user', content: 'Hello' }])
    })

    it('should transform all whitelisted models', () => {
      const transformer = createModelTransformer('accounts/test/models/')
      const whitelistedModels = [
        'qwen3-235b-a22b-instruct-2507',
        'qwen3-235b-a22b-thinking-2507',
        'kimi-k2-instruct',
        'deepseek-r1-0528',
        'qwen3-235b-a22b',
        'llama-v3p1-405b-instruct',
      ]

      for (const model of whitelistedModels) {
        const body = new TextEncoder().encode(
          JSON.stringify({
            model,
            messages: [],
          }),
        )

        const result = transformer(body)
        const resultData = JSON.parse(new TextDecoder().decode(result))

        expect(resultData.model).toBe(`accounts/test/models/${model}`)
      }
    })

    it('should not transform if model already has checkPrefix', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/', 'accounts/')
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507',
          messages: [],
        }),
      )

      const result = transformer(body)
      const resultData = JSON.parse(new TextDecoder().decode(result))

      // Should remain unchanged because it already has the accounts/ prefix
      expect(resultData.model).toBe('accounts/fireworks/models/qwen3-235b-a22b-instruct-2507')
    })

    it('should transform if model is whitelisted but does not have checkPrefix', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/', 'accounts/')
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: 'qwen3-235b-a22b-instruct-2507',
          messages: [],
        }),
      )

      const result = transformer(body)
      const resultData = JSON.parse(new TextDecoder().decode(result))

      expect(resultData.model).toBe('accounts/fireworks/models/qwen3-235b-a22b-instruct-2507')
    })

    it('should handle requests without model field', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/')
      const body = new TextEncoder().encode(
        JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          temperature: 0.7,
        }),
      )

      const result = transformer(body)
      const resultData = JSON.parse(new TextDecoder().decode(result))

      expect(resultData.messages).toEqual([{ role: 'user', content: 'Hello' }])
      expect(resultData.temperature).toBe(0.7)
      expect(resultData.model).toBeUndefined()
    })

    it('should handle non-string model field', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/')
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: 123, // Non-string model
          messages: [],
        }),
      )

      const result = transformer(body)
      const resultData = JSON.parse(new TextDecoder().decode(result))

      expect(resultData.model).toBe(123) // Should remain unchanged
    })

    it('should handle invalid JSON gracefully', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/')
      const body = new TextEncoder().encode('invalid json {')

      const result = transformer(body)

      // Should return original body when parsing fails
      expect(result).toEqual(body)
    })

    it('should handle empty body', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/')
      const body = new Uint8Array()

      const result = transformer(body)

      // Should return original body
      expect(result).toEqual(body)
    })

    it('should preserve other fields when transforming model', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/')
      const originalData = {
        model: 'qwen3-235b-a22b-instruct-2507',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        max_tokens: 100,
        stream: true,
        metadata: { user: 'test-user', session: 'session-123' },
      }
      const body = new TextEncoder().encode(JSON.stringify(originalData))

      const result = transformer(body)
      const resultData = JSON.parse(new TextDecoder().decode(result))

      expect(resultData).toEqual({
        ...originalData,
        model: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507',
      })
    })

    it('should work with different prefix formats', () => {
      const transformers = [
        createModelTransformer('prefix/'),
        createModelTransformer('prefix'),
        createModelTransformer('some/deep/path/prefix/'),
        createModelTransformer(''),
      ]

      const body = new TextEncoder().encode(
        JSON.stringify({
          model: 'qwen3-235b-a22b-instruct-2507',
        }),
      )

      const results = transformers.map((transformer) => {
        const result = transformer(body)
        return JSON.parse(new TextDecoder().decode(result))
      })

      expect(results[0].model).toBe('prefix/qwen3-235b-a22b-instruct-2507')
      expect(results[1].model).toBe('prefixqwen3-235b-a22b-instruct-2507')
      expect(results[2].model).toBe('some/deep/path/prefix/qwen3-235b-a22b-instruct-2507')
      expect(results[3].model).toBe('qwen3-235b-a22b-instruct-2507')
    })

    it('should handle complex checkPrefix scenarios', () => {
      const transformer = createModelTransformer('accounts/fireworks/models/', 'accounts/fireworks/')

      // Should transform (has accounts/ but not accounts/fireworks/)
      const body1 = new TextEncoder().encode(
        JSON.stringify({
          model: 'accounts/other/qwen3-235b-a22b-instruct-2507',
        }),
      )
      const result1 = transformer(body1)
      const resultData1 = JSON.parse(new TextDecoder().decode(result1))
      expect(resultData1.model).toBe('accounts/other/qwen3-235b-a22b-instruct-2507') // No change because not whitelisted

      // Should not transform (already has accounts/fireworks/)
      const body2 = new TextEncoder().encode(
        JSON.stringify({
          model: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507',
        }),
      )
      const result2 = transformer(body2)
      const resultData2 = JSON.parse(new TextDecoder().decode(result2))
      expect(resultData2.model).toBe('accounts/fireworks/models/qwen3-235b-a22b-instruct-2507')

      // Should transform (whitelisted and no accounts/fireworks/ prefix)
      const body3 = new TextEncoder().encode(
        JSON.stringify({
          model: 'qwen3-235b-a22b-instruct-2507',
        }),
      )
      const result3 = transformer(body3)
      const resultData3 = JSON.parse(new TextDecoder().decode(result3))
      expect(resultData3.model).toBe('accounts/fireworks/models/qwen3-235b-a22b-instruct-2507')
    })
  })
})
