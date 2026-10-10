# Known issues

<!-- Human-owned. The QA judge drops any finding that matches an entry here, so list bugs that are already
     tracked or accepted, and remove an entry once it is fixed. One bullet per issue: the area, what the user
     sees or the error text, and why it is known (tracked, accepted, or wontfix). Keep the list short: every
     entry is read by the judge on every call. -->

- Skills form: the Slug is not generated from names without Latin letters or digits (emoji, CJK, Arabic, Hebrew),
  so Create stays disabled until a slug is typed. Intended.
- Google integration: it cannot list calendars, so the app's AI sees only the primary calendar (for example, a
  shared work calendar is missed) unless the user gives a calendar id. Intended.
- Sync: only the c7 leg has a sync backend (Postgres + PowerSync). On every other leg `/v1/powersync/*` returns 404
  and nothing syncs, so findings that depend on synced data (an empty Settings → Devices list, another device's
  state) are environment artifacts, not bugs.
- Artifacts: the console shows "Blocked script execution" for an HTML artifact. The inline card runs the
  artifact's scripts only after the app has settled and the card is on screen (never while it streams), so until
  then the sandboxed frame blocks them. Intended. An artifact that never renders or never works once it is on
  screen is still a bug.
