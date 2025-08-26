// Manual test script to verify tokenizer functionality
// Run with: node --loader tsx src/ai/test-tokenizer-manual.ts

import { validateTokenLimit, getContextWindow, getTokenLimitErrorMessage } from './tokenizer'
import { Model } from '@/types'

const testModel: Model = {
  id: 'test-1',
  provider: 'openai',
  name: 'GPT-4',
  model: 'gpt-4',
  url: null,
  apiKey: 'test-key',
  isSystem: 0,
  enabled: 1,
  toolUsage: 1,
  isConfidential: 0,
  startWithReasoning: 0,
}

async function runTests() {
  console.log('🧪 Testing Token Validation System\n')

  // Test 1: Basic functionality
  console.log('Test 1: Basic token counting')
  try {
    const messages = [
      { role: 'user', content: 'Hello, how are you?' },
      { role: 'assistant', content: 'I am doing well, thank you!' }
    ]
    const systemPrompt = 'You are a helpful assistant.'
    
    const result = await validateTokenLimit(messages, systemPrompt, testModel)
    console.log('✅ Basic test passed')
    console.log(`   Tokens: ${result.tokens}`)
    console.log(`   Context Window: ${result.contextWindow}`)
    console.log(`   Max Tokens: ${result.maxTokens}`)
    console.log(`   Within Limit: ${result.isWithinLimit}`)
    console.log(`   Overhead: ${result.overhead}`)
  } catch (error) {
    console.log('❌ Basic test failed:', error)
  }

  // Test 2: Context window detection
  console.log('\nTest 2: Context window detection')
  const models = ['gpt-4', 'gpt-4o', 'claude-3-sonnet-20240229', 'qwen2.5-72b-instruct', 'mistral-large-latest']
  models.forEach(model => {
    const contextWindow = getContextWindow(model)
    console.log(`   ${model}: ${contextWindow.toLocaleString()} tokens`)
  })

  // Test 3: Error message generation
  console.log('\nTest 3: Error message generation')
  const errorResult = {
    tokens: 5000,
    contextWindow: 4096,
    maxTokens: 2048,
    isWithinLimit: false,
    overhead: 10
  }
  const errorMessage = getTokenLimitErrorMessage(errorResult)
  console.log('✅ Error message generated:')
  console.log(`   "${errorMessage.substring(0, 100)}..."`)

  // Test 4: Long message simulation
  console.log('\nTest 4: Long message handling')
  try {
    const longMessage = 'This is a very long message that repeats many times. '.repeat(50)
    const messages = [{ role: 'user', content: longMessage }]
    const systemPrompt = 'You are helpful.'
    
    const result = await validateTokenLimit(messages, systemPrompt, testModel)
    console.log('✅ Long message test completed')
    console.log(`   Tokens: ${result.tokens}`)
    console.log(`   Within Limit: ${result.isWithinLimit}`)
  } catch (error) {
    console.log('❌ Long message test failed:', error)
  }

  console.log('\n🎉 Token validation tests completed!')
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error)
}