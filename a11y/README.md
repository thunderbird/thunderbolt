# WCAG audit

A manual accessibility audit of a running Thunderbolt. It walks the main screens, runs axe-core and a few
scripted checks, and writes `a11y/report.md` (gitignored). It is not part of CI or `bun run test`.

```sh
bun run a11y
```

## Targets

Set `A11Y_BASE_URL`; the default is a local dev server at `http://localhost:1420`.

| Target                 | Command                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| Local dev server       | start the app (`bun run dev`), then `bun run a11y`                     |
| PR preview             | `A11Y_BASE_URL=https://app-pr-<n>.preview.thunderbolt.io bun run a11y` |
| Production, signed out | `A11Y_BASE_URL=https://app.thunderbolt.io bun run a11y`                |

## Signing in

Production is read-only by default. For any host that is not localhost or `*.preview.thunderbolt.io`, the
harness only loads the signed-out entry screen and skips the signed-in test (and onboarding), because on an
anonymous deployment a signed-in run creates an anonymous account, completes onboarding (which writes synced
settings) and sends analytics events. Set `A11Y_SIGNED_IN=1` only if you accept that. The report's
**Coverage** section says when this happened.

On local and preview targets the harness opens `/` in a fresh browser and looks at what appears:

- **Keycloak (PR previews).** It signs in through the shared Keycloak with `demo` / `demo`. Override with
  `A11Y_USERNAME` and `A11Y_PASSWORD`.
- **Emailed code (local e2e stack only).** It can only continue if the backend accepts a fixed code. Pass it
  as `A11Y_SIGN_IN_CODE` (the e2e stack uses `12345678`). Production never accepts one, and the harness
  refuses this path on non-local hosts.
- **Already in the app** (an anonymous deployment, or an SSO deployment that signs in on its own) needs
  nothing. On an anonymous deployment this creates an anonymous account.

When it can't sign in, it still audits the signed-out entry screen and the report's **Coverage** section says
the signed-in screens were skipped.

## What it checks

axe-core's WCAG 2.0/2.1/2.2 A and AA rules plus best practices on each screen in light and dark, and scripted
checks for keyboard focus visibility, focus return after closing dialogs (account menu, search), reflow at 200%
and 400% zoom, and controls that share a name.

Screens: signed-out entry, chat home, and the Preferences, Models, Connections, Skills and Devices settings.
Set `A11Y_PROMPTS=1` to also send one real prompt and audit the answer (needs a working model, and uses quota).

It can't check how a screen reader actually reads things (VoiceOver or NVDA browse mode, announcement order).
Spot-check those by hand.

The script runs the report even when a test fails, and exits with the test run's status.
