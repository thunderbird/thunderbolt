# Whole-app coverage

Contents: depth and evidence rules; current-code gates; P0 smoke; P1 core; P2 secondary.

Instantiate each row into runnable checks before driving. Prefer current
`.github/qa/functions.json`, `journeys.json`, and `charters/` for web details; read
`src/app.tsx`, enabled settings/navigation, feature flags and the touched code to add
new enabled surfaces. This is a prioritized floor, not a frozen inventory of routes.
Smoke=P0, core=P0+P1 (default), full=all. W=web, D=macOS desktop, I=iOS, A=Android;
“all” in the target column means the feature is eligible on W/D/I/A, subject to
**current-code gates**. Execute only selected targets. Default unavailable targets go
in explicit coverage gaps; explicitly requested unavailable targets retain BLOCKED
matrix columns. Eligibility is not session availability.
Every row records check → expected result, target(s), prerequisites and cheapest evidence.
Split compound rows into subchecks if their outcomes/evidence differ. Capture live app
success; test names or an existing screenshot are not current platform evidence.

## Verify these gates against current code

| Gate | Consequence to verify before setting expectations |
|---|---|
| HTTP routes | Read src/lib/proxy-fetch.ts + src/ai/fetch.ts: web normally proxies; Tauri preference + native_fetch determine direct/proxy; loopback custom URLs direct. Browser/WebView CORS, mixed content/local-network permission and Tauri CSP host/ports still apply. |
| ACP/MCP transports | ACP WS policy differs from HTTP; inspect WS relay evidence. stdio MCP unsupported unless current code adds support. |
| Minimal mode | Verify which settings/projects/voice are hidden; mark N/A with code/config evidence, not PASS. |
| Passkeys | Verify consumer auth mode, flag, supported OS versions and RP app.thunderbolt.io; simulator/localhost may not satisfy all prerequisites. |
| Responsive/mini apps | <768px web uses mobile; Tauri desktop remains desktop at narrow width. Mini apps are wide web/desktop only; verify breakpoints/guards. |
| Sync/local state | Verify synced tables vs local data: secrets, MCP definitions and attachment blobs are device-local; do not expect them to replicate. |
| Native operations | Downloads, external links, deep links, tray, haptics, safe areas and updates differ by target/capability. Verify current shell implementations. |
| Feature/account/service flags | Tasks/voice/dev settings, integrations/Pro search, confidential models and legacy migrations require explicit enabled state/fixtures. Missing credentials/services = BLOCKED; disabled-by-code = N/A. |

## P0 — smoke

| ID | Check → expected result | Platforms | Prerequisites | Cheapest evidence |
|---|---|---|---|---|
| S01 | Cold startup/auth gate: waitlist, SSO or anonymous per config → correct destination, no redirect loop | all | Known auth/config; clean disposable profile; local stack | Final screen + navigation/request assertion; redirect chain when applicable |
| S02 | Request email code, sign in → correct user reaches app; bad/expired code rejected when scoped | all | Consumer mode; approved test email; private fresh code channel | Post-submit UI/user assertion + sanitized success status; never code capture |
| S03 | Complete each enabled onboarding step, restart midway/after → progress/values survive | all | Onboarding enabled; fresh account | Before/restart/after state assertions + screenshots |
| S04 | Visit every enabled settings page, reload a deep link, open unknown route and legacy MCP URLs → correct content, Not Found and redirect | all | Discover routes/navigation from current code | Route-to-heading assertions + final screens; count every enabled page |
| S05 | Send chat, observe partial updates, reopen/reload thread → complete reply persists once | all | Reachable compatible provider/fake | Ordered partial/final/persisted text assertions; short trace/video |
| S06 | Stop while thinking, streaming and retrying → work stops, state settles, next message works | all | Provider that produces each state; controlled retry fixture | Before/after transition assertions + cancellation/network evidence |
| S07 | Change synced data on device 1, await device 2, then reverse → both converge without duplicate rows | all, two real targets | Same account; Postgres+PowerSync; approved devices | Device IDs + two UI states + DB/sync assertion; not two viewport sizes |
| S08 | Launch with IndexedDB unavailable → explicit unavailable/error screen, no endless loader | all where gated | Isolated profile; controlled storage failure | Visible blocker + storage-failure assertion, restore environment |
| S09 | Hit backend with below-minimum app version → 426 and upgrade blocker; exempt flow still works | all | Isolated backend MIN_APP_VERSION; current exemptions | Sanitized status/envelope + blocker screenshot; fresh control without gate |

## P1 — core (plus P0)

| ID | Check → expected result | Platforms | Prerequisites | Cheapest evidence |
|---|---|---|---|---|
| C01 | Long history scroll, switch threads → correct positions/messages; no cross-thread content | all | Two seeded conversations, long history | Thread IDs + scroll/switch/reopen assertions |
| C02 | Rename/move/delete thread and clear-all → intended UI state; deletes are soft, other data intact | all | Disposable threads/projects | UI persistence + deletedAt DB assertion, not UI disappearance alone |
| C03 | Fail chat, recover/Retry and trigger 429 → actionable guidance, usable composer, no duplicates | all | Controlled failure/rate-limit endpoint | Error/retry success assertions + sanitized status |
| C04 | Render markdown, code, math, tables, reasoning, tools, citations; copy and quote-reply → correct content/actions | all | Deterministic response/tool fixture | Per-format DOM/AX assertions + screenshot; clipboard assertion without secrets |
| C05 | Save composer draft, navigate/restart; press Enter/Shift+Enter → draft retained and target-specific send/newline | all | Current desktop/mobile preference/keyboard | Text/action count assertions + keyboard result |
| C06 | Attach images, PDF, DOCX, XLSX, MD, TXT, CSV, JSON → accepted, usable in chat; previews open | all | Safe sample files; supported provider | Each file type upload/result + preview screenshot/assertion |
| C07 | Attach >10 files, >25 MiB and unsupported type; choose text-only model with image → clear limits/remediation | all | Boundary fixtures; verify current thresholds | Boundary rejection + valid control + model-remediation result |
| C08 | Open document previews → correct content, scrolling/close/download works per target | all | Uploaded supported docs | Preview text/assertions + target download evidence |
| C09 | Select provided models and confidential threads → available models work and privacy rules hold | all | Current catalog/account permissions | Model ID + reply and confidentiality behavior assertions |
| C10 | Custom model add/test/edit/enable/disable/delete → correct catalog/chat behavior and persisted state | all | OpenAI fake and/or real permitted endpoint | CRUD/test/chat assertions; soft-delete check where persisted |
| C11 | Keep/clear/replace custom-model secret → empty edit keeps, clear removes, replacement used without leakage | all | Disposable model; named private keys | Masked UI + connection outcomes; no raw secret/state dump |
| C12 | OpenAI-compatible catalog success/failure and manual Custom fallback → selection and chat work | all | Bundled fake; induced catalog failure | Catalog request + chosen model ID + known reply |
| C13 | Toggle Use Cloud Proxy ON/OFF, repeat remote and loopback catalog/test/chat → current routing rules hold | all | Native capability; non-loopback positive control; CSP-allowed fake | UI success + target log mark deltas + positive control; endpoint hits |
| C14 | Theme, name, haptics, external-link preferences → visible/persisted settings and native effects | all, gated | Native capability where needed | Restart assertions; screenshot/theme diff; observed haptic/link result |
| C15 | Switch language without reload; units and X-App-Language → all reactive copy/formatting and headers update | all | Two locales + relevant number/date/weather | Before/after UI assertions + safe language header; no host-locale assumptions |
| C16 | Create/edit skills, slash-invoke and pin/unpin → updated instruction/selection and pins persist | all | Disposable skill | UI/chat effect + reload assertions |
| C17 | Search with Cmd/Ctrl+K, accents, CJK and commands → correct results, highlights and navigation | all, keyboard gated | Mixed-language content; command fixture | Query-to-result assertions + command action; mobile entry point too |
| C18 | Create/edit projects, assign chats, switch/delete → correct membership/isolation and soft deletion | all, minimal gate | Disposable project/threads | Membership UI + persistence/DB assertions |
| C19 | MCP add/connect/list tools/call/disconnect/reconnect; OAuth/bearer pending/expired states → correct lifecycle | all | Echo Streamable HTTP; auth fixture for OAuth/bearer | Tool echo + status transitions; WS/HTTP policy checked separately |
| C20 | Built-in/system/custom ACP agents, choose and converse → correct agent/tools/stream lifecycle | all, capability gated | Working ACP service/identity | Agent ID + conversation/tool assertions + WS evidence |
| C21 | Auth negatives and session expiry → actionable rejection/re-auth, protected data inaccessible | all | Disposable expired session; isolated auth mode | Rejection status + visible state + successful fresh control |
| C22 | E2EE first device and extra device approve/deny → decrypt only approved devices; deny stays blocked | all, two targets | E2EE enabled; clean disposable account | Device IDs + approve/deny UI and decryption assertions |
| C23 | Change recovery phrase and exercise recovery → intended old/new recovery behavior | all, gated | Disposable encrypted account; private phrase handling | Sanitized success/failure state only, never phrase capture |
| C24 | Register/authenticate/remove passkey → current RP/OS/security flow works | all where supported | Consumer + flag + supported OS + RP; verify code | Native prompt/result + server credential state, no secret material |
| C25 | Devices list/revoke another device → correct state, revoked device loses access/sync | all, two targets | Disposable secondary device | Both devices' screens + backend rejection assertion |
| C26 | Logout keep vs wipe and sign back in → local data retained/removed as selected | all | Separate disposable profiles | Before/logout/relogin storage/UI assertions |
| C27 | Delete account → confirmation completes; related data/access removed across devices | all | Explicit disposable account; isolate from other checks | Backend/account absence + both target access rejection |

## P2 — secondary (plus P0/P1)

| ID | Check → expected result | Platforms | Prerequisites | Cheapest evidence |
|---|---|---|---|---|
| X01 | Tasks create/edit/run/cancel/history → correct state transitions and result | all, flag gated | Tasks enabled; safe task | State/result assertions + cancellation evidence |
| X02 | Widgets: citation, connect-integration, document-result, weather, link-preview, map, ask → each renders and actions work | all, service gated | Deterministic tool results/integration fixtures | Per-widget visible content + action assertion |
| X03 | Artifacts render_html, panel/inline, copy/download/context selection and sandbox errors → usable output and isolation | all, capability gated | Safe HTML fixture + deliberate sandbox error | DOM/screen + download/copy/context assertions + sandbox failure control |
| X04 | Mini apps create/open/interact → usable wide layout; hidden on unsupported widths | W/D wide only | Verify current gate; safe mini app | Wide interaction + narrow exclusion evidence |
| X05 | Voice enter/record/cancel/permission/replay → working flow or clear denied state | all, flag/minimal gated | Mic permission; supported voice provider | Native prompt/state + recording/playback assertion without private audio |
| X06 | Google/Microsoft connect/revoke and Pro search → correct linked state/results/error recovery | all, service gated | OAuth credentials/test account; Pro entitlement | Sanitized callback/state + search result/citation assertion |
| X07 | Import connection and iroh connect/reconnect → valid definitions and usable remote connection | all, transport gated | Safe import + reachable peer | Import state + successful operation + reconnect assertion |
| X08 | Export/import backup → selected data round-trips; invalid backup rejected | all | Disposable data/private export; target download support | Export existence + restored row/content comparison; safe report summary |
| X09 | Reset local DB, telemetry/tasks consent → intended reset and consent persisted | all, capability gated | Disposable profile; separate from sync tests | Restart/storage/consent assertions; native confirmation as applicable |
| X10 | Magic/OAuth deep links cold/warm + CLI device grant → correct app/session/account and completion | all, platform gated | Registered dev schemes; disposable CLI device flow | Native launch + callback/assertion + CLI grant status; no callback secrets |
| X11 | Legacy E2EE migration → old data readable and upgraded safely | all where supported | Versioned legacy fixture; backup | Before/after schema/data/decryption assertions |
| X12 | Update checks/install prompt and CLI installation → correct target/version/error state | D/I/A as implemented; W CLI offer | Verify updater/channel/OS gates; safe dry-run or disposable install | Version/prompt/installed binary evidence; block destructive/unavailable paths |
| X13 | Native shell tray, second instance, safe areas and keyboard → intended window/focus/layout/input | D/I/A by implementation | Actual native target; inspect shell code | Native UI capture + focus/instance/keyboard assertions; pixel diff for layout |
| X14 | Dev settings, en-XA pseudo-locale, debug transcript share → gated access, readable expansion, safe export | all, dev gated | Dev build; non-sensitive transcript | Route/gate + localization capture + sanitized export assertion |

Before reporting, total instantiated checks by platform and compare with selected depth.
Mark every unavailable service or unexecuted check BLOCKED; list code-verified disabled
features as N/A exclusions. Explicitly state two-device, destructive-account and external
integration gaps. Existing unit/e2e/native-smoke automation proves only its own execution,
not a current native target pass. Do not stop at P0 and call a requested core/full run complete.
