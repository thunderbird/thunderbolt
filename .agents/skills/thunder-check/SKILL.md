---
name: thunder-check
description: Run Thunderbolt's type, lint and format checks (make check) and fix what fails. Use after code changes, before committing, or when asked to check types, lint or formatting.
---

Run `make check`. On failure: type errors → fix them; lint → `make lint-fix`, then fix what remains by hand; format → `make format`. Re-run `make check` until it passes, then report a summary of what was fixed and anything still failing.
