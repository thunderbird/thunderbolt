import { chromium } from 'playwright'

const APP_URL = 'http://localhost:1420'
const RENDER_URL = 'https://mcp.render.com/mcp'
const RENDER_TOKEN = 'rnd_96vWJm4AQ6LA74pDAHTFgxK5mWpo'

const main = async () => {
  console.log('=== Render MCP E2E Validation ===\n')

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  const mcpLogs: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('MCP') || text.includes('mcp') || text.includes('tool') || text.includes('conflict') || text.includes('render')) {
      mcpLogs.push(`[${msg.type()}] ${text}`)
    }
  })

  // 1. Load app + dismiss onboarding
  console.log('1. Loading app...')
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForTimeout(3000)
  for (let i = 0; i < 10; i++) {
    const checkbox = await page.$('button[role="checkbox"]')
    if (checkbox) { await checkbox.click({ force: true }); await page.waitForTimeout(500) }
    const btn = await page.$('button:has-text("Skip")') || await page.$('button:has-text("Continue")') || await page.$('button:has-text("Start Using")')
    if (btn) { try { await btn.click({ timeout: 2000 }) } catch { await btn.click({ force: true }) }; await page.waitForTimeout(1000) } else { break }
  }
  console.log('   Done\n')

  // 2. Go to MCP settings, delete all servers
  console.log('2. Cleaning up existing servers...')
  await page.goto(`${APP_URL}/settings/mcp-servers`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  for (let i = 0; i < 5; i++) {
    const trash = await page.$('button:has(svg.lucide-trash-2)')
    if (!trash) { break }
    await trash.click(); await page.waitForTimeout(500)
    const remove = await page.$('button:has-text("Remove")')
    if (remove) { await remove.click(); await page.waitForTimeout(1000) }
  }
  console.log('   Cleaned\n')

  // 3. Add Render MCP
  console.log('3. Adding Render MCP server...')
  const addBtn = await page.$('button:has(svg.lucide-plus)') || await page.$('button:has-text("Add Server")')
  if (addBtn) { await addBtn.click(); await page.waitForTimeout(1000) }

  // Fill URL
  const urlInput = await page.$('input#url')
  if (urlInput) { await urlInput.fill(RENDER_URL) }

  // Select bearer auth
  const comboboxes = await page.$$('[role="combobox"]')
  if (comboboxes.length >= 2) {
    await comboboxes[1].click(); await page.waitForTimeout(300)
    const bearerOpt = await page.$('[role="option"]:has-text("API Key")')
    if (bearerOpt) { await bearerOpt.click(); await page.waitForTimeout(500) }
  }

  // Fill token
  const tokenInput = await page.$('input#bearer-token')
  if (tokenInput) { await tokenInput.fill(RENDER_TOKEN) }
  await page.waitForTimeout(500)

  // 4. Test Connection
  console.log('4. Testing connection...')
  const testBtn = await page.$('button:has-text("Test Connection")')
  if (testBtn) { await testBtn.click() }
  await page.waitForTimeout(15000)

  const success = await page.$('text=Connection successful')
  const failed = await page.$('text=Connection failed')
  if (success) {
    console.log('   PASS: Connection successful!\n')

    // Count tools
    const toolItems = await page.$$('li')
    console.log(`   Tools found: ${toolItems.length}\n`)
  } else if (failed) {
    const errorText = await page.textContent('.bg-red-50')
    console.log(`   FAIL: ${errorText}\n`)
    await page.screenshot({ path: '.team/screenshots/render-connection-failed.png' })
    await browser.close()
    return
  } else {
    console.log('   TIMEOUT: No success or failure indicator after 15s\n')
    await page.screenshot({ path: '.team/screenshots/render-timeout.png' })
    await browser.close()
    return
  }

  // 5. Add Server — scroll dialog to bottom first, then force click
  console.log('5. Adding server...')
  const dialog = await page.$('[role="dialog"]')
  if (dialog) {
    await dialog.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await page.waitForTimeout(500)
  }
  const addServerBtn = await page.$('button:has-text("Add Server"):not(:has-text("Add MCP"))')
  if (addServerBtn) { await addServerBtn.click({ force: true }) }
  await page.waitForTimeout(5000)

  // Check if modal closed and server appears in list
  const dialogStillOpen = await page.$('[role="dialog"]')
  if (dialogStillOpen) {
    console.log('   WARNING: Modal still open after Add Server')
    await page.screenshot({ path: '.team/screenshots/render-modal-stuck.png' })
  } else {
    console.log('   Modal closed, server added')
  }

  // Check server card
  const serverCard = await page.$('text=render')
  if (serverCard) {
    console.log('   PASS: Server card visible in list\n')
  } else {
    console.log('   Server card not found in list')
    await page.screenshot({ path: '.team/screenshots/render-no-card.png' })
  }

  // 6. Open chat and send message
  console.log('6. Opening chat...')
  await page.goto(`${APP_URL}/chats/new`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  mcpLogs.length = 0 // Reset logs before chat

  console.log('7. Sending message...')
  const chatInput = await page.$('textarea')
  if (chatInput) {
    await chatInput.fill('list my render workspaces')
    await page.waitForTimeout(500)
    await chatInput.press('Enter')
    console.log('   Message sent, waiting 20s for response...')
    await page.waitForTimeout(20000)
  }

  await page.screenshot({ path: '.team/screenshots/render-chat-response.png' })

  // Print MCP logs
  console.log('\n=== MCP Console Logs ===')
  for (const log of mcpLogs) {
    console.log(log)
  }

  // Get response text
  const bodyText = await page.textContent('main') ?? ''
  const responseLines = bodyText.split('\n').filter(l => l.trim().length > 10).slice(-5)
  console.log('\n=== Last lines of page ===')
  for (const line of responseLines) {
    console.log(line.trim().substring(0, 200))
  }

  console.log('\n=== Validation Complete ===')
  await browser.close()
}

main().catch(console.error)
