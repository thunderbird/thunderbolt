# c1-first-run: a brand-new user's first visit

Goal: onboarding, the first chat and leaving the app work for someone who has never used Thunderbolt.

Start state: the onboarding build, at **http://localhost:1425**.

1. Sign in with a fresh address. Go through every onboarding step, then the welcome dialog.
   Edge cases: back and forward between steps, a reload in the middle, skipping optional steps, an empty and a
   300-character name. Functions: `sign-in`, `onboarding-complete`, `onboarding-back`, `onboarding-name`,
   `welcome-dialog`.
2. First chat: select "Opus 5.5", send a message, wait for the reply, reload and check the chat is still there.
   Function: `first-chat`.
3. Log out keeping the data, sign back in with the same address, check the chat is still there.
   Function: `sign-out-keep`.
4. Log out deleting the data from this device, sign back in, check what remains. Function: `sign-out-wipe`.
5. Delete the account from the settings, then try to sign in with the same address again.
   Function: `delete-account`.

Specs for this charter: import `onboardingURL` from exactly `'../../../.github/qa/ports'`, start with
`test.use({ baseURL: onboardingURL })` and sign in with `const email = await enterEmailCode(page)`, because
`loginViaEmailCode` expects onboarding to be off. To sign back in with the same address, call
`enterEmailCode(page, email)`: the backend refuses a second code for an address within 15 s, and the helper waits
that out. Give such a spec `test.setTimeout(120_000)`.

Out of bounds: settings beyond what these steps need.
