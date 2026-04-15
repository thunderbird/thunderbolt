/**
 * Diagnostic script: runs a SINGLE simple scenario and logs every raw detail.
 * Usage: bun run src/ai/eval/debug-single.ts
 */
import { aiFetchStreamingResponse } from '@/ai/fetch'
import { getSettings } from '@/dal'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { defaultModelGptOss120b } from '@/defaults/models'
import { defaultModeChat } from '@/defaults/modes'
import { getAuthToken } from '@/lib/auth-token'
import { createAuthenticatedClient } from '@/lib/http'
import type { SaveMessagesFunction } from '@/types'
import { v7 as uuidv7 } from 'uuid'
import { parseStream } from './stream-parser'
import { extractCitations, extractLinkPreviewUrls, extractWidgets } from './scoring'

const run = async () => {
  console.log('=== EVAL DEBUG: Single Scenario ===\n')

  console.log('[1/5] Setting up database...')
  await setupTestDatabase()
  console.log('[1/5] Database ready.\n')

  const modelId = defaultModelGptOss120b.id
  const prompt = "What's the current price of Bitcoin?"
  const saveMessages: SaveMessagesFunction = async () => {}

  const body = JSON.stringify({
    messages: [{ id: uuidv7(), role: 'user', parts: [{ type: 'text', text: prompt }] }],
    id: uuidv7(),
  })

  console.log(`[2/5] Model: ${defaultModelGptOss120b.name} (${modelId})`)
  console.log(`[2/5] Mode: ${defaultModeChat.name}`)
  console.log(`[2/5] Prompt: "${prompt}"\n`)

  const db = getDb()
  const { cloudUrl } = await getSettings(db, { cloud_url: 'http://localhost:8000/v1' })
  const httpClient = createAuthenticatedClient(cloudUrl, getAuthToken)

  console.log('[3/5] Calling aiFetchStreamingResponse...')
  const start = performance.now()

  const response = await aiFetchStreamingResponse({
    init: { method: 'POST', body },
    saveMessages,
    modelId,
    modeSystemPrompt: defaultModeChat.systemPrompt ?? undefined,
    modeName: defaultModeChat.name,
    httpClient,
  })

  const callDuration = ((performance.now() - start) / 1000).toFixed(1)
  console.log(`[3/5] Response status: ${response.status} (${callDuration}s)\n`)

  console.log('[4/5] Parsing stream with parseStream()...')
  const parsed = await parseStream(response)
  const parseDuration = ((performance.now() - start) / 1000).toFixed(1)

  console.log(`[4/5] Parse complete (${parseDuration}s total)`)
  console.log(`  Steps: ${parsed.stepCount}`)
  console.log(
    `  Tool calls: ${parsed.toolCalls.length} (${parsed.toolCalls.map((t) => t.toolName).join(', ') || 'none'})`,
  )
  console.log(`  Finish reason: ${parsed.finishReason}`)
  console.log(`  Retries: ${parsed.retryCount}`)
  console.log(`  Text length: ${parsed.text.length} chars`)
  if (parsed.error) {
    console.log(`  Error: ${parsed.error}`)
  }

  console.log('\n[5/5] Response analysis:')
  console.log('─'.repeat(60))

  const citations = extractCitations(parsed.text)
  const widgets = extractWidgets(parsed.text)
  const linkUrls = extractLinkPreviewUrls(parsed.text)

  console.log(`  Citations: ${citations.length} (${citations.join(', ') || 'none'})`)
  console.log(`  Widgets: ${widgets.length} (${widgets.join(', ') || 'none'})`)
  console.log(`  Link previews: ${linkUrls.length}`)

  if (parsed.text.trim()) {
    console.log('\n  Response text:')
    console.log('─'.repeat(60))
    console.log(parsed.text)
    console.log('─'.repeat(60))
  } else {
    console.log('\n  *** EMPTY — no text content in parsed stream ***')
  }

  console.log(`\nTotal time: ${((performance.now() - start) / 1000).toFixed(1)}s`)

  await teardownTestDatabase()
}

await run()
