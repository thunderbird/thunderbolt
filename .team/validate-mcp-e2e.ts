/**
 * E2E validation: Add Render MCP server and verify tools register correctly.
 * Captures console logs to diagnose tool registration issues.
 */
import { chromium } from 'playwright'

const APP_URL = 'http://localhost:1425'
const RENDER_URL = 'https://mcp.render.com/mcp'
const RENDER_TOKEN = 'rnd_96vWJm4AQ6LA74pDAHTFgxK5mWpo'

const main = async () => {
  console.log('=== MCP E2E Validation ===\n')

  const browser = await chromium.launch({ headless: false })
  const page = await browser.newPage()

  // Capture ALL console messages
  const consoleLogs: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    consoleLogs.push(`[${msg.type()}] ${text}`)
    if (text.includes('MCP tool') || text.includes('mcp') || text.includes('conflict')) {
      console.log(`  [CONSOLE] ${text}`)
    }
  })

  page.on('pageerror', (err) => {
    console.log(`  [PAGE ERROR] ${err.message}`)
  })

  // 1. Load app and dismiss onboarding
  console.log('1. Loading app...')
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForTimeout(3000)

  // Dismiss onboarding if present
  for (let i = 0; i < 10; i++) {
    const btn = await page.$('button[role="checkbox"]')
    if (btn) {
      await btn.click({ force: true })
      await page.waitForTimeout(500)
    }
    const skip = await page.$('button:has-text("Skip")') || await page.$('button:has-text("Continue")') || await page.$('button:has-text("Start Using")')
    if (skip) {
      try { await skip.click({ timeout: 2000 }) } catch { await skip.click({ force: true }) }
      await page.waitForTimeout(1000)
    } else {
      break
    }
  }
  console.log('   Onboarding handled\n')

  // 2. Go to MCP settings and delete all existing servers
  console.log('2. Navigating to MCP settings...')
  await page.goto(`${APP_URL}/settings/mcp-servers`, { waitUntil: 'domcontentloaded', timeout: 10000 })
  await page.waitForTimeout(2000)

  // Delete all existing MCP servers
  const deleteButtons = await page.$$('button:has(svg.lucide-trash-2)')
  console.log(`   Found ${deleteButtons.length} existing servers to delete`)
  for (const btn of deleteButtons) {
    await btn.click()
    await page.waitForTimeout(500)
    const confirmBtn = await page.$('button:has-text("Remove")')
    if (confirmBtn) {
      await confirmBtn.click()
      await page.waitForTimeout(1000)
    }
  }
  console.log('   All servers deleted\n')

  // 3. Add Render MCP server
  console.log('3. Adding Render MCP server...')
  const addBtn = await page.$('button:has(svg.lucide-plus)')
  if (!addBtn) {
    // Try the "Add Server" button in empty state
    const addServerBtn = await page.$('button:has-text("Add Server")')
    if (addServerBtn) {
      await addServerBtn.click()
    }
  } else {
    await addBtn.click()
  }
  await page.waitForTimeout(1000)

  // Fill URL
  const urlInput = await page.$('input#url')
  if (urlInput) {
    await urlInput.fill(RENDER_URL)
  }

  // Select bearer auth
  const authSelect = (await page.$$('[role="combobox"]'))[1]
  if (authSelect) {
    await authSelect.click()
    await page.waitForTimeout(300)
    const bearerOption = await page.$('[role="option"]:has-text("API Key")')
    if (bearerOption) {
      await bearerOption.click()
      await page.waitForTimeout(500)
    }
  }

  // Fill bearer token
  const tokenInput = await page.$('input#bearer-token')
  if (tokenInput) {
    await tokenInput.fill(RENDER_TOKEN)
  }
  await page.waitForTimeout(500)

  // Test connection
  console.log('   Testing connection...')
  const testBtn = await page.$('button:has-text("Test Connection")')
  if (testBtn) {
    await testBtn.click()
    await page.waitForTimeout(10000) // Wait for connection test
  }

  // Check if connection succeeded
  const successIndicator = await page.$('text=Connection successful')
  if (successIndicator) {
    console.log('   Connection test PASSED\n')
  } else {
    const errorIndicator = await page.$('text=Connection failed')
    if (errorIndicator) {
      console.log('   Connection test FAILED\n')
      await page.screenshot({ path: '.team/screenshots/e2e-connection-failed.png' })
    }
  }

  // Add server
  console.log('4. Adding server...')
  const addServerBtn = await page.$('button:has-text("Add Server")')
  if (addServerBtn) {
    await addServerBtn.click()
    await page.waitForTimeout(3000)
  }

  // Screenshot the settings page
  await page.screenshot({ path: '.team/screenshots/e2e-after-add.png' })
  console.log('   Server added, screenshot saved\n')

  // 4. Navigate to chat
  console.log('5. Opening new chat...')
  await page.goto(`${APP_URL}/chats/new`, { waitUntil: 'domcontentloaded', timeout: 10000 })
  await page.waitForTimeout(3000)

  // Clear console logs before sending message
  const preMessageLogs = [...consoleLogs]
  consoleLogs.length = 0

  // 5. Send a message
  console.log('6. Sending message: "list my render workspaces"...')
  const chatInput = await page.$('textarea') || await page.$('[contenteditable]') || await page.$('input[placeholder*="Ask"]')
  if (chatInput) {
    await chatInput.fill('list my render workspaces')
    await page.waitForTimeout(500)

    // Press Enter or click send
    await chatInput.press('Enter')
    console.log('   Message sent, waiting for response...')
    await page.waitForTimeout(15000) // Wait for AI response
  }

  // 6. Capture results
  await page.screenshot({ path: '.team/screenshots/e2e-chat-response.png' })

  console.log('\n=== Console logs during chat ===')
  for (const log of consoleLogs) {
    if (log.includes('MCP') || log.includes('mcp') || log.includes('tool') || log.includes('conflict') || log.includes('error') || log.includes('Error')) {
      console.log(log)
    }
  }

  console.log('\n=== All MCP-related logs ===')
  for (const log of [...preMessageLogs, ...consoleLogs]) {
    if (log.includes('MCP') || log.includes('mcp') || log.includes('prefix') || log.includes('render')) {
      console.log(log)
    }
  }

  // Get page text to see AI response
  const responseText = await page.textContent('main') || await page.textContent('body')
  console.log('\n=== Page content (truncated) ===')
  console.log(responseText?.substring(0, 500))

  console.log('\n=== E2E Validation Complete ===')
  await browser.close()
}

main().catch(console.error)
