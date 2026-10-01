# c7-two-devices: one account on two devices

Target: an account used on two devices stays in sync, from turning sync on to revoking a device.
Risks: changes that never reach the other device or arrive wrong, an approval or recovery flow that strands a device,
a revoked device that keeps its access.
Start state: two separate browsers: `mcp__playwright__*` is device A and `mcp__playwright_b__*` is device B. Desktop
viewport, fake AI (select "Opus 5" on each device). Cloud sync is available in this setup.
Specs for this mission: sign in device A with `loginViaEmailCode(page)`. For device B, copy A's
`page.context().storageState()` into `browser.newContext({ storageState })` after removing the localStorage entries
`thunderbolt_device_id` and `thunderbolt_user_cache_secret`, then turn sync on in both, as a user would.
Out of bounds: account deletion.
