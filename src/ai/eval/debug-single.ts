/**
 * Diagnostic script: runs a SINGLE simple scenario and logs every raw detail.
 * Usage: bun run src/ai/eval/debug-single.ts
 */
import { aiFetchStreamingResponse } from '@/ai/fetch'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { defaultModelGptOss120b } from '@/defaults/models'
import { defaultModeChat } from '@/defaults/modes'
import type { SaveMessagesFunction } from '@/types'
import { v7 as uuidv7 } from 'uuid'

const run = async () => {
  console.log('=== EVAL DEBUG: Single Scenario ===\n')

  // 1. Setup
  console.log('[1/6] Setting up database...')
  await setupTestDatabase()
  console.log('[1/6] Database ready.\n')

  // 2. Prepare request
  const modelId = defaultModelGptOss120b.id
  const prompt = "What's the current price of Bitcoin?"
  const saveMessages: SaveMessagesFunction = async () => {}

  const body = JSON.stringify({
    messages: [{ id: uuidv7(), role: 'user', parts: [{ type: 'text', text: prompt }] }],
    id: uuidv7(),
  })

  console.log(`[2/6] Model: ${defaultModelGptOss120b.name} (${modelId})`)
  console.log(`[2/6] Mode: ${defaultModeChat.name}`)
  console.log(`[2/6] Prompt: "${prompt}"\n`)

  // 3. Call AI pipeline
  console.log('[3/6] Calling aiFetchStreamingResponse...')
  const start = performance.now()

  const response = await aiFetchStreamingResponse({
    init: { method: 'POST', body },
    saveMessages,
    modelId,
    modeSystemPrompt: defaultModeChat.systemPrompt ?? undefined,
    modeName: defaultModeChat.name,
  })

  const callDuration = ((performance.now() - start) / 1000).toFixed(1)
  console.log(`[3/6] Response received in ${callDuration}s. Status: ${response.status}\n`)

  // 4. Read raw stream
  console.log('[4/6] Reading raw stream bytes...')
  const reader = response.body?.getReader()
  if (!reader) {
    console.error('ERROR: No response body!')
    return
  }

  const decoder = new TextDecoder()
  const rawChunks: string[] = []
  let totalBytes = 0
  let chunkCount = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunkCount++
    totalBytes += value?.length ?? 0
    const text = decoder.decode(value, { stream: true })
    rawChunks.push(text)
  }

  // Flush decoder
  const finalFlush = decoder.decode()
  if (finalFlush) rawChunks.push(finalFlush)

  const rawOutput = rawChunks.join('')
  console.log(`[4/6] Stream complete: ${chunkCount} chunks, ${totalBytes} bytes\n`)

  // 5. Show raw stream lines
  console.log('[5/6] Raw stream lines:')
  console.log('─'.repeat(60))
  const lines = rawOutput.split('\n')
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue
    const prefix = line.substring(0, line.indexOf(':'))
    const payload = line.substring(line.indexOf(':') + 1)
    const truncated = payload.length > 200 ? payload.substring(0, 200) + '...' : payload
    console.log(`  [line ${i}] prefix="${prefix}" payload=${truncated}`)
  }
  console.log('─'.repeat(60))

  // 6. Extract text content
  console.log('\n[6/6] Extracted text:')
  const textParts: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const prefix = line.substring(0, colonIdx)
    const payload = line.substring(colonIdx + 1)
    if (prefix === '0') {
      try {
        textParts.push(JSON.parse(payload) as string)
      } catch {
        textParts.push(payload)
      }
    }
  }

  const fullText = textParts.join('')
  if (fullText.trim()) {
    console.log('─'.repeat(60))
    console.log(fullText)
    console.log('─'.repeat(60))
  } else {
    console.log('  *** EMPTY — no text content found in stream! ***')
    console.log(`  Total lines: ${lines.length}`)
    console.log(`  Lines with prefix "0": ${lines.filter((l) => l.startsWith('0:')).length}`)
    console.log(`  Lines with prefix "d": ${lines.filter((l) => l.startsWith('d:')).length}`)
    console.log(`  Lines with prefix "e": ${lines.filter((l) => l.startsWith('e:')).length}`)
    console.log(`  Lines with prefix "9": ${lines.filter((l) => l.startsWith('9:')).length}`)
    console.log(`  Lines with prefix "f": ${lines.filter((l) => l.startsWith('f:')).length}`)
  }

  const totalDuration = ((performance.now() - start) / 1000).toFixed(1)
  console.log(`\nTotal time: ${totalDuration}s`)

  await teardownTestDatabase()
}

await run()
