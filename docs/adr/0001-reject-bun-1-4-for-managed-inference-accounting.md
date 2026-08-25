---
status: accepted
---

# Reject Bun 1.4 for managed inference accounting

Managed inference needs a usage and cost ledger plus shared rolling quotas for DeepSeek V4 Flash, Claude Opus 5, and GLM-5.2. Bun 1.4.0 could have kept usage observation for all three models inside the backend, but runtime qualification found reproducible authentication-suite failures. We will remain on the current runtime and use a constrained signed-receipt fallback for GLM.

## Context

The accounting system needs authoritative token quantities, request-start prices, costs, and quota updates. DeepSeek V4 Flash and Claude Opus 5 return plaintext OpenAI-compatible SSE bodies on direct requests. The backend can read their usage chunks while it streams the response.

GLM-5.2 has a different transport boundary. Its response remains EHBP encrypted while passing through the backend, so the backend cannot inspect the decrypted SSE body. Tinfoil sends authoritative streaming usage at the end of the response in an HTTP trailer. If the backend runtime exposes that trailer, GLM can use the same server-side accounting lifecycle as the other models even though the observation format differs.

Bun 1.3.14 does not expose the needed trailer. Both Fetch and `node:https` discard valid response trailers, including responses where `IncomingMessage.complete` is `true`. Node 22 exposes the same trailers. Bun 1.4.0 rewrote and fixed Node HTTP behavior, so upgrading the application runtime was a plausible way to make the Tinfoil trailer visible without adding another process or moving general accounting responsibility to the frontend.

## Evidence

The official temporary macOS arm64 Bun 1.4.0 binary was verified before use. Its GitHub asset size was 25,568,657 bytes and its SHA-256 digest was `c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381`. Initial fixture testing did not modify the global Bun installation or the repository.

An exact trusted-CA HTTP/1.1 trailer fixture passed under Bun 1.4.0. The fixture used an ordinary `node:https` server and confirmed `complete=true`, exact `trailers` and `rawTrailers` values, binary body identity, and a negative case without the required `TE` negotiation. This established that Bun 1.4.0 could expose the GLM usage trailer through the backend's existing runtime.

Qualification then treated Bun as the application engine, not as a narrow HTTP library. Ordinary root installation, tests, checks, and builds passed. Backend tests, type checks, lint, and builds also passed. A one-line lockfile metadata migration removed only a pseudo-key comment, after which frozen installs passed. These results established that the candidate runtime could install and build the application and that its trailer fix worked as required.

## What failed in Thunderbolt

The blocking test was the full backend non-WebSocket suite. It ran in a fresh process with randomized ordering, a fixed seed of `3303918247`, and every test rerun five times. This was an application-level runtime check, not a focused test of the new accounting code.

The results were reproducible at the command level:

- Bun 1.4.0, run 1: 5,002 passed and 3 failed.
- Bun 1.4.0, run 2 with the same seed: 5,002 passed and 3 failed.
- Bun 1.3.14, with the exact same full command and seed: 5,005 passed and 0 failed.
- Bun 1.4.0, with only the two OTP files isolated under the same seed and five reruns: 190 passed and 0 failed.

The failures came from two unique tests:

1. `OTP Security Hardening > Measure 2 > should allow requesting a new code after exhaustion, and old code is invalid`: after the test exhausted the allowed attempts and requested a new OTP, signing in with `newOtp` threw `APIError INVALID_OTP` before the test reached its user assertion.
2. `Auth Waitlist Integration > OTP resend strategy (reuse) > should generate a fresh OTP with reset counter after attempts are exhausted (known limitation)`: `signInSucceeded` was `false` instead of `true`.

The report contains three failure instances because each test was eligible to run five times. A unique test can therefore fail in more than one rerun. The result does not identify a third distinct authentication defect.

No watchdog fired, no timeout occurred, and PGlite did not hang. The isolated OTP files also passed. The failure appears only in the full suite, which points to order-dependent, shared-state, timing, or runtime behavior. Several explanations remain possible: Bun 1.4.0 may have changed test-runner isolation or timing, the suite may contain a latent cleanup defect, or authentication behavior may differ under the new runtime. The investigation did not establish which explanation is correct. This evidence does not prove a production authentication failure, and it does not assign a cause to Bun beyond the observed runtime difference.

The unresolved result still blocks acceptance. Bun is the entire backend runtime, not a leaf dependency. OTP exhaustion and resend are part of an authentication security path. The current runtime passes the exact control command, while Bun 1.4.0 repeatedly fails it. We could not safely classify the result as harmless test flakiness, so the engine-wide rollout failed the zero-unexplained-auth-regression gate.

The failure was found before native validation. macOS, iOS, and Android builds were not run after it, so they are unproven under Bun 1.4.0, not failed.

## Decision

Do not upgrade to Bun 1.4.0 for managed inference accounting. Keep the current runtime. Do not backport or fork the runtime's HTTP implementation.

If Bun 1.4.0 had qualified, the backend could have captured GLM's authoritative trailer itself. All three models would then have kept server-owned token quantities, request-start prices, costs, and quota updates in one ledger and quota pipeline. DeepSeek and Opus would be observed through SSE usage chunks, while GLM would be observed through an HTTP trailer. Trust ownership and request lifecycle would remain the same. No frontend receipt, new process, or custom HTTP parser would be needed.

The chosen fallback preserves one shared price, ledger, and quota architecture. The backend remains authoritative for DeepSeek and Opus usage. For GLM, SecureClient decrypts an `include_usage` SSE step and returns a server-signed per-step receipt. Only GLM token quantities become cooperative and therefore forgeable. The user, model, request-start price, calculated cost, and replay protection remain server-owned. This mechanism controls accidental cost; it is not an anti-fraud boundary.

## Considered options

A GLM-only Node helper or sidecar could read the trailer, but it would add another process, deployment unit, and lifecycle to one provider path.

Undici under Bun 1.3.14 was tested as an in-process alternative. Bun suppressed the required `Connection: TE` behavior, and the approach stalled during a large upload.

A manual HTTP parser could expose trailers without changing runtimes. It would also make the application responsible for HTTP framing and related security details, which is too much risk for this feature.

Using non-streaming GLM responses could simplify final usage collection, but it would materially harm chat responsiveness and user experience.

Upgrading Bun 1.4.0 would provide the cleanest accounting boundary, but only if the entire application engine qualified. The authentication-suite evidence ruled it out for this work.

## Consequences

The ledger, price snapshot, cost calculation, replay controls, and rolling-quota enforcement stay shared across all managed models. GLM alone gets a different usage producer. Its quantities depend on a cooperative client, so the quota system cannot claim fraud resistance for GLM. This limitation is explicit and contained rather than hidden behind a nominally uniform interface.

Remaining on the current runtime avoids an unresolved authentication risk and avoids maintaining a private Bun patch. It also means the backend cannot yet use Tinfoil's authoritative trailer, even though the provider already supplies the information needed for a fully server-owned design.

## Revisit criteria

The Bun runtime decision can be reconsidered after the order or state interaction is root-caused and fixed under Bun 1.4.0, or when a later Bun release is available for qualification. In either case, acceptance requires the complete matrix again: the exact trailer fixture, frozen installs, ordinary root and backend tests, checks and builds, repeated full-suite runs, and native macOS, iOS, and Android builds.

The GLM receipt producer can also be replaced with server-side observation if Tinfoil provides request-scoped usage lookup, usage inside a backend-readable response body, or authenticated metrics the backend can read without decrypting model content.

Neither change should require a new ledger or quota design. It should replace only the GLM usage producer while preserving the shared request-start price, cost, replay, ledger, and quota pipeline.
