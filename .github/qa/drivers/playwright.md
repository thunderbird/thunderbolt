## Your driver: the browser

- You drive a real browser only through the Playwright MCP tools (`mcp__playwright__*`; a two-device charter also
  has `mcp__playwright_b__*`). They may appear only after your first turn: never conclude they are missing.
- The app runs at http://localhost:1424 unless your charter says otherwise; its backend is http://localhost:8005.
- Use `browser_evaluate` only to read the page (for example to read a value), never to change it. Never pass a `filename` to a
  browser tool.
- After every major action (submit, save, delete, navigate, reload) read `browser_console_messages` and, when
  something looks wrong, `browser_network_requests`.
- A tool's result shows only a count of console errors, never the lines. After every navigation, wait about 1 s and
  call `browser_console_messages`, and call it again whenever the error count grows.
- Take a screenshot with `browser_take_screenshot` (no `filename`) of every new screen, and again after you focus a
  text field, then look at it the way a user would.
- A function marked "(after a reload)" passes only when its outcome still shows after a reload (`browser_navigate`
  to the same URL) that you did after the change. Check any other change that should persist the same way.
- Prefer `browser_fill_form` and one `browser_snapshot` per screen over many small calls.
- The third field of a `visual` finding:
  - `screenshot`: the screenshot that shows the defect. Its tool result gives the file's full path: your output
    directory, then `mcp/` (`mcp-b/` for the second device), then the file name. Write the part from `mcp` on, for
    example `mcp/page-2026-10-19T16-08-14-750Z.png`.

### The second file of a finding: its repro spec

2. Except for a `visual` finding, `<output directory>/repro/<n>.spec.ts`: a Playwright test that FAILS while the
   bug exists and PASSES once it is fixed, because it asserts the expected behaviour. A spec that breaks any rule
   below is thrown away:
   - Import only from `@playwright/test`, from exactly `'../../../e2e/helpers'`, for a `layout` finding
     from exactly `'../../../.github/qa/layout'`, and for a c1 spec from exactly `'../../../.github/qa/ports'`.
   - Put the assertion that fails while the bug exists in `await test.step('bug check', async () => { … })`, after
     the steps that reach the screen, and keep those steps outside it. Replay counts a run as the bug only when it
     failed inside that step: a run that failed on the way there (sign-in, a locator) proves nothing. A spec without
     the step is thrown away.
   - Helpers: `loginViaEmailCode(page)` signs in a fresh user and waits for the chat composer (it returns the email);
     `enterEmailCode(page, email?)` only opens the entry page, requests a code and types it, so it also works with
     onboarding on (it returns the email). Both take an earlier call's email to sign the same user in again, and
     then wait out the backend's 15 s cooldown per address. `sendChatPrompt(page, text)` sends a chat message;
     `collectPageErrors(page)` returns an array that fills with uncaught errors; `openSidebarOnMobile(page)` opens
     the sidebar on a phone. The base URL is set, so use relative
     URLs such as `page.goto('/settings/skills')`.
   - Before its first chat message, a spec selects the model you used, just as you did:
     `await page.getByTestId('model-selector-trigger').click()`, then
     `await page.getByRole('button', { name: 'Opus 5.5', exact: true }).click()` (or the other model's name).
     Otherwise no reply ever comes.
   - A `layout` spec reaches the screen, repeats the action and asserts, in its `bug check` step,
     `expect(await layoutProblems(page)).toEqual([])`, where `layoutProblems` comes from
     `'../../../.github/qa/layout'`. It returns the problems the page shows by then, each `{ kind, target }`. Set a
     phone's viewport first, as below.
   - An `ai-reported-failure` spec sends the same prompt and waits for the reply to finish: the "Stop generating"
     button shows, then is hidden (allow 120 s, and call `test.setTimeout(180_000)`). Then it asserts what a working
     feature shows (a role, label or text of the widget or tool result) and that no text matches a case-insensitive
     regex of the failure words you quoted. A real model words every reply differently, so match loosely: the spec
     is replayed three times, and two failures confirm the bug.
   - After an action that saves, wait until the page shows the result (the new item or value) before the spec
     reloads or navigates away, so a reload never beats the save.
   - A phone finding sets its viewport first: `test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })`.
     `test.use` takes only `viewport`, `baseURL`, `isMobile`, `hasTouch`, `deviceScaleFactor`, `locale`,
     `timezoneId` and `colorScheme`, written inline.
   - Use role, label, text or test-id locators. No `x[i]` with a variable index: use `.nth(i)` or `for … of`.
   - Plain JavaScript besides Playwright: no `process`, `fetch`, `require`, `eval`, `Function`, `globalThis`,
     `Object`, `Reflect`, `Error`, `crypto`, `Bun`, `constructor`, `prototype`, names starting with `_`,
     `test.only` or `test.extend`. For unique values use `Date.now()` or `Math.random()`.
   - Specs only read the page; they never save files, so no `path` option, `saveAs` or snapshot matchers.
   - One test per file, named after the finding. No `waitForTimeout` longer than 2 s.
