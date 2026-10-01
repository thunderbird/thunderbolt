# c7-two-devices: one account on two devices

Goal: an account used on two devices stays in sync.

Start state: two separate browsers: `mcp__playwright__*` is device A and `mcp__playwright_b__*` is device B. Desktop
viewport, fake AI (select "Opus 5" on each device). Cloud sync is available in this setup.

1. Sign in on device A with a fresh address. Turn on "Sync This Device With Cloud" in Settings → Preferences.
2. Sign in on device B with the same address and turn sync on too. Follow any device-approval or recovery-key flow
   the app shows, from both sides. Function: `sync-on`.
3. On A, create a chat and send a message; check it appears on B without a reload. Rename and delete it on B;
   check A. Do the same with a skill and a setting (for example the theme). Functions: `chat-sync`, `skill-sync`,
   `setting-sync`.
4. Settings → Devices on A: check both devices are listed, then revoke B and see what B shows.
   Functions: `devices-list`, `device-revoke`.

Specs for this charter: sign in device A with `loginViaEmailCode(page)`. For device B, copy A's
`page.context().storageState()` into `browser.newContext({ storageState })` after removing the localStorage entries
`thunderbolt_device_id` and `thunderbolt_user_cache_secret`, then turn sync on in both, as a user would.

Out of bounds: account deletion.
