# Security

## Reporting Vulnerabilities

If you discover a security vulnerability in Thunderbolt, please report it responsibly via our [vulnerability reporting form](https://github.com/thunderbird/thunderbolt/security/advisories/new).

Please do **not** file public GitHub issues for security vulnerabilities.

## Scope

Everything this repository builds is in scope:

| Area                                               | Path                                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| React client (web, PWA) and shared code            | `src/`, `shared/`                                           |
| Tauri shell — desktop, iOS, Android                | `src-tauri/`                                                |
| Wasm relay client for the CLI ACP/MCP bridge       | `crates/thunderbolt-acp-client/`                            |
| Backend API (Elysia on Bun)                        | `backend/`                                                  |
| Terminal CLI                                       | `cli/`                                                      |
| PowerSync sync rules and service config            | `deploy/config/powersync-config.yaml`, `powersync-service/` |
| Self-host deployment (Compose, Kubernetes, Pulumi) | `deploy/`                                                   |
| Public web surfaces                                | `web/`                                                      |

Two areas are worth naming, because they take attacker-influenced input by design:

- **The universal proxy.** `/v1/proxy` fetches a target URL supplied by the client, so the app can reach model providers and MCP servers from a browser. It rejects schemes other than `http(s)`, resolves the hostname up front and refuses private, reserved and IPv4-mapped ranges, then connects to the pinned IP with the original `Host` header so a second DNS answer cannot rebind it — including on each redirect hop (`backend/src/utils/url-validation.ts`, `backend/src/proxy/routes.ts`). A way past that validation is a vulnerability worth reporting.
- **Optional end-to-end encryption.** Coverage is per column and opt-in: with `E2EE_ENABLED` on, the client encrypts the columns listed in `encryptedColumnsMap` (`src/db/encryption/config.ts`) before sync, and the server holds only ciphertext and wrapped keys for those columns. Everything else syncs in plaintext. See [E2E Encryption](./docs/internals/architecture/e2e-encryption.md) for the key hierarchy and device-approval flows.

## Supported Versions

Releases are cut from `main` as a single unified `v{version}` tag covering desktop, iOS, Android and the CLI (`.github/workflows/release.yml`). There are no maintenance branches, so a security fix lands on `main` and ships in the next release rather than being backported to an older tag. **Only the most recent release is supported.**

Two channels carry fixes sooner, without a stability guarantee:

- **Daily app releases.** The daily pipeline runs E2E at 04:00 UTC and, only if it passes, publishes a patch release (`vX.Y.Z`) marked Latest that also ships to the desktop auto-updater, TestFlight and the Play internal track. Releases carry a "may be unstable" warning.
- **Container images.** `images-publish.yml` pushes to GHCR on every `main` push touching `deploy/**`, `backend/**`, `src/**`, `package.json` or the two `shared/` modules in its `paths` filter, and `nightly-images.yml` rebuilds daily at 05:00 UTC to pick up upstream base-image updates. A self-hosted deployment tracking `:latest` gets fixes without waiting for an app release.

Thunderbolt is [undergoing a security audit and is not yet intended for production use](./docs/self-hosting/README.md). That caveat is about our own readiness; please still report what you find.

## Out of Scope

- **Evaluation defaults in a self-hosted stack.** `deploy/docker-compose.yml` hardcodes a PowerSync JWT secret, an OIDC client secret and Postgres credentials so the stack comes up unattended — `BETTER_AUTH_SECRET` is the one value it refuses to default. Replacing them before exposing a deployment is the operator's job; see [self-hosting configuration](./docs/self-hosting/configuration.md). A report that these published values are published is not a finding.
- **Readable fields and pre-upgrade rows.** End-to-end encryption covers the columns in `encryptedColumnsMap` (`shared/e2ee-types.ts`); ids, timestamps and the other fields outside it are readable server-side by design. So are rows synced in plain text before a deployment upgraded to always-on encryption, which are not re-encrypted. Both are documented behaviour, not leaks.
- **Third-party services.** Model providers, MCP servers, OAuth and OIDC identity providers, and the other upstreams a deployment is pointed at. Report those to their owners.

## What to Expect

The advisory thread is the whole channel: we triage there, ask follow-up questions there, and say there when a fix has merged and which release carries it. Advisories stay private until we publish them, and we will credit you in the published advisory unless you would rather we did not. We do not yet commit to a fixed response window.

Please test against your own self-hosted instance or your own account. Do not read other people's data, degrade the service for other users, or social-engineer contributors or staff. If you are unsure whether a test is in bounds, open the advisory and ask before running it.
