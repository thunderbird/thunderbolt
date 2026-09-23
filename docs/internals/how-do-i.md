# How do I...?

A task index. Most of these docs describe how a subsystem works; this page maps
what you are trying to do onto the page that tells you.

## Add something

| Task                              | Where                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A synced table                    | [PowerSync · Account & Devices](architecture/powersync-account-devices.md#adding-a-new-synced-table). Two PRs, in order. Read the whole section first. |
| A column to a synced table        | [PowerSync · Account & Devices](architecture/powersync-account-devices.md#adding-columns-to-an-existing-synced-table)                                  |
| An encrypted column               | [End-to-end encryption](architecture/e2e-encryption.md#adding-a-new-encrypted-column)                                                                  |
| A local-only (device) table       | [Data access layer](architecture/data-access-layer.md)                                                                                                 |
| A default row users get on signup | [Reconciled defaults](architecture/reconciled-defaults.md#changing-a-default). Bump the version constant or devices ping-pong.                         |
| A client data migration           | [Client data migrations](architecture/client-data-migrations.md)                                                                                       |
| A backend route                   | [Backend API surface](architecture/backend-api-surface.md#adding-a-route). Decide the auth mode, rate tier and version gate.                           |
| A rate limit on a route           | [Rate limiting](../../backend/docs/rate-limiting.md#adding-a-limit-to-a-new-route)                                                                     |
| A tool the model can call         | [System prompt, tools and citations](architecture/prompt-and-tools.md#changing-any-of-this)                                                            |
| A skill                           | [Skills](architecture/skills.md)                                                                                                                       |
| A widget                          | [Widgets](widgets.md#how-widgets-work)                                                                                                                 |
| A searchable entity               | [Search](architecture/search.md#adding-an-entity-to-the-index)                                                                                         |
| An attachment file type           | [Attachments](architecture/attachments.md#adding-a-file-type)                                                                                          |
| A module in `shared/`             | [The shared/ module](architecture/shared-module.md#adding-a-module)                                                                                    |
| A field to debug transcripts      | [Debug transcripts](architecture/debug-transcripts.md#adding-a-field-to-the-payload)                                                                   |
| A panel in the content view       | [Content view](architecture/content-view.md#adding-to-it)                                                                                              |
| A sync transformer                | [PowerSync · Sync middleware](architecture/powersync-sync-middleware.md#adding-a-non-encryption-transformer)                                           |
| A user-facing string              | `AGENTS.md`, Localization. Every string goes through a Lingui macro, including `aria-label` and `placeholder`.                                         |
| A component                       | [Frontend structure](development/frontend-structure.md)                                                                                                |

## Change something

| Task                               | Where                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| A shipped default (models, skills) | [Reconciled defaults](architecture/reconciled-defaults.md#changing-a-default)               |
| The system prompt                  | [System prompt, tools and citations](architecture/prompt-and-tools.md#changing-any-of-this) |
| Managed inference defaults         | [Managed inference](architecture/managed-inference.md#changing-the-defaults)                |
| A setting, synced or device-local  | [Settings and preferences](architecture/settings-and-preferences.md)                        |
| Deployment configuration           | [Configuration](../self-hosting/configuration.md)                                           |

## Run and test

| Task                        | Where                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| Get the app running locally | [Quick start](development/quick-start.md)                               |
| Run the test suites         | [Testing](development/testing.md#running-tests). Never bare `bun test`. |
| Write a new e2e spec        | [Testing](development/testing.md#writing-new-specs)                     |
| Run backend tests           | [Backend testing](../../backend/docs/testing.md#running-tests)          |
| Run on a phone or simulator | [Mobile setup](development/mobile-setup.md#running-on-a-simulator)      |
| Browse components           | [Storybook](dev-tooling/storybook.md)                                   |
| Run the AI reviewer locally | [AI code review](dev-tooling/ai-code-review.md#running-it-locally)      |
| See what CI will run        | [CI and preview environments](development/ci-and-previews.md)           |

## Self-host and operate

| Task                       | Where                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| Pick a deployment shape    | [Self-hosting overview](../self-hosting/README.md)                                         |
| Run it with Docker Compose | [Docker Compose](../self-hosting/docker-compose.md)                                        |
| Run it on Kubernetes       | [Kubernetes](../self-hosting/kubernetes.md)                                                |
| Run it on AWS with Pulumi  | [Pulumi](../self-hosting/pulumi.md)                                                        |
| Configure environment      | [Configuration](../self-hosting/configuration.md)                                          |
| Set up OIDC or SAML        | [OIDC](../../backend/docs/oidc-local-dev.md), [SAML](../../backend/docs/saml-local-dev.md) |
| Host an iroh relay         | [iroh relay](architecture/iroh-relay-self-hosting.md)                                      |
| Manage personal tokens     | [PAT lifecycle](../../backend/docs/pat-lifecycle.md)                                       |

## Debug

| Symptom                          | Where                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A test passes alone, fails in CI | [Debugging mock leakage](development/testing.md#debugging-mock-leakage)                                                             |
| SSO login fails locally          | [OIDC](../../backend/docs/oidc-local-dev.md#troubleshooting), [SAML](../../backend/docs/saml-local-dev.md#troubleshooting)          |
| Desktop updates do not apply     | [Local CDN for app updates](dev-tooling/local-cdn-for-app-update-testing.md#troubleshooting)                                        |
| Data is not reaching a device    | [Multi-device sync](architecture/multi-device-sync.md), then [Upload authorization](architecture/powersync-upload-authorization.md) |
| A chat turn fails                | [Chat runtime](architecture/chat-runtime.md), then [Debug transcripts](architecture/debug-transcripts.md)                           |
| An LLM or MCP call is rejected   | [Universal proxy](architecture/universal-proxy.md)                                                                                  |

## Understand the system

Start at the [architecture overview](architecture/README.md). `AGENTS.md` at the
repo root carries the conventions that apply everywhere: TypeScript and React
rules, localization, responsive sizing, the app-version gate, and reconciled
defaults.
