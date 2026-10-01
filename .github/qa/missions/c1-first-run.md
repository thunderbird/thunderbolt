# c1-first-run: a brand-new user's first visit

Target: onboarding, the first chat and leaving the app, for someone who has never used Thunderbolt.
Risks: an onboarding that loses what was entered or traps the user, a first chat that vanishes, sign-out and account
deletion that keep or wipe the wrong data.
Start state: this build shows onboarding. The app runs at **http://localhost:1425** (not 1424), desktop viewport.
Specs for this mission: start with `test.use({ baseURL: 'http://localhost:1425' })` and sign in by hand
(`page.goto('/')`, fill the "Email" field, press Continue, fill `input[autocomplete="one-time-code"]` with
`12345678`), because `loginViaEmailCode` expects onboarding to be off.
Out of bounds: settings beyond what these functions need.
