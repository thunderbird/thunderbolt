# Security and Privacy

What Thunderbolt stores, what leaves your infrastructure, and what you can and cannot see as the
operator of a deployment.

> **Not production-ready.** Thunderbolt is undergoing a security audit. End-to-end encryption is a
> preview feature and has not had a cryptography audit. Evaluate it, but do not put it in front of
> real users yet.

## The short version

| Question                                             | Answer                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Where do conversations live?                         | On each device first. On your server only if the user turns sync on.                      |
| Who else sees a prompt?                              | Whichever model provider answers it, and a web search provider if the model searches.     |
| Can you read a user's chats?                         | With sync on and encryption off, yes, from your database. With encryption on, no.         |
| Where are provider API keys?                         | On the device that entered them. They never reach your server or another device.          |
| Is anything sent to the Thunderbolt team by default? | No. Analytics are off unless you configure a key and the user opts in.                    |
| Does Thunderbolt store uploaded files?               | No. Files stay on the device and are sent only inside the request that answers that turn. |

## Where data lives

| Data                                                            | On the device | On your server                      |
| --------------------------------------------------------------- | ------------- | ----------------------------------- |
| Chats, messages, tasks, skills, projects, automations, settings | Always        | Only when the user enables sync     |
| Model configuration (names, endpoints, tuning)                  | Always        | Only when the user enables sync     |
| External agent entries (name, address, description)             | Always        | Only when the user enables sync     |
| The device list (names, last-seen times)                        | Always        | Always                              |
| Provider API keys                                               | Always        | Never                               |
| Tool server addresses and their credentials                     | Always        | Never                               |
| External agent credentials                                      | Always        | Never                               |
| Uploaded files (PDFs, images, documents)                        | Always        | Never                               |
| Account record and sign-in sessions                             | No            | Always                              |
| Managed inference usage (model, token counts, cost)             | No            | Always, when you run managed models |

A **tool server** here means an MCP server: a small service a user points the app at so the model can
call its tools.

Every device keeps a full local database and reads and writes there first, so the app works offline
once the user is signed in. Sync is per user and off until they turn it on. With `POWERSYNC_URL`
unset there is no sync at all and your server never receives conversation data.

Even with sync on, uploaded file contents, provider API keys, and tool server addresses and
credentials never leave the device: a file attached on a laptop is not readable from the same
account's phone, and a tool server has to be added again on each device.

## End-to-end encryption

Off by default. Turn it on before your first users sign in:

```ini
E2EE_ENABLED=true
```

The server is the source of truth for the setting, and apps read it at startup. There is no client
setting to match.

**What changes when it is on**

- Each device generates its own key pair. Private keys never leave the device.
- One account-wide content key encrypts the data. A copy of it is sealed to each device's public
  key and stored on your server, so only that device can open its own copy.
- A new device stays in a pending state until an already-trusted device approves it.
- The user is shown a 24-word recovery phrase once, at setup. It is the only way back in if every
  trusted device is lost. You cannot recover it for them.
- Revoking a device deletes its sealed copy of the content key from your server, so the device
  cannot decrypt anything again even if its local keys survive.

**What it covers**

| Encrypted before upload                                                                                           | Stays readable on the server                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Message content, chat titles, task text, saved prompts, skill text, project names and instructions, device names  | Record ids, timestamps, relationships, ordering, deletion markers, on/off flags          |
| Setting values, model names and endpoints and descriptions, per-model tuning overrides, automation schedule times | External agent entries: an agent's name, address, description and icon sync in the clear |

The external agent gap is a known omission rather than a design decision, and a fix is planned.
Anything not listed as encrypted syncs as plain text.

**Limits worth knowing before you commit**

- Encryption covers what is synced. It is not a limit on what the model provider sees: the prompt is
  decrypted on the device and sent to the provider that answers it.
- Turning encryption on later does not re-encrypt rows already synced in plain text.
- A user is capped at 10 trusted devices per account.
- No cryptography audit yet.

With encryption off, the server auto-trusts each device: no approval step, no recovery phrase, and
your database holds readable conversation content.

## What leaves your deployment

| Destination                                    | What it receives                                                                                                                           | How to stop it                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model providers the user adds                  | The prompt, conversation history, and attachments, plus the user's own API key                                                             | Point users at a local model server instead                                                                                                                                                    |
| Tool servers and external agents the user adds | An MCP server gets the arguments of each tool call; an external agent gets the conversation it answers. Both get the user's own credential | `ALLOW_CUSTOM_AGENTS=false` blocks user-added agents. MCP servers have no equivalent switch                                                                                                    |
| Managed models you configure                   | Depends on the tier, see below                                                                                                             | Leave the provider keys unset                                                                                                                                                                  |
| Exa (web search, page fetch)                   | The search query, and the URL of any page the model reads                                                                                  | Leave `EXA_API_KEY` unset. These tools also require Thunderbolt Pro, so they are unavailable by default; a Pro user can switch the **Thunderbolt** connection off under Settings → Connections |
| Open-Meteo                                     | A place name or coordinates, for location search and weather                                                                               | Not separately configurable today                                                                                                                                                              |
| Resend                                         | The recipient address for sign-in codes and waitlist mail                                                                                  | Leave `RESEND_API_KEY` unset, which also disables email sign-in                                                                                                                                |
| PostHog                                        | Product analytics, never prompt or response content                                                                                        | Leave `POSTHOG_API_KEY` unset                                                                                                                                                                  |
| The Thunderbolt team                           | Nothing, unless you configure debug transcript forwarding                                                                                  | Leave `DEBUG_TRANSCRIPT_UPSTREAM_URL` unset, which is the default                                                                                                                              |

Requests to a user-added provider or tool server pass through your server, because a browser cannot
call most provider APIs directly. Your server forwards the bytes and the user's credential untouched
and stores neither. Access logs record the upstream hostname, not the full URL, so a user's browsing
is not written into your logs. The exception is a model server on the user's own machine, such as
Ollama or LM Studio: your server cannot reach it, so the app calls it directly and nothing about
those turns crosses your infrastructure.

Your server also fetches pages itself, with no user credential attached, to build link previews:
a link a user pastes or a model returns becomes a request from your infrastructure to that site.

Before enabling debug transcripts: a transcript carries the whole conversation plus the user id and
email your deployment holds, is retained by the Thunderbolt team, and survives deletion of the
submitting account.

## Managed models and confidential inference

"Managed" means your deployment holds the provider key and any signed-in user can chat without
configuring anything. There are two tiers.

| Tier         | Enabled by                                 | What your server sees                                                                            |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Direct       | `ANTHROPIC_API_KEY` or `FIREWORKS_API_KEY` | The full request and the response stream                                                         |
| Confidential | `TINFOIL_API_KEY`                          | Neither. The device encrypts the request for a verified enclave and your server relays the bytes |

An **enclave** is a hardware-isolated environment the model runs inside. Before sending anything,
the device checks the enclave's attestation, a signed statement of exactly which software is running
there, and encrypts the request so that only that enclave can open it. Your server holds no key that
can open the payload.

The default shipped model is a confidential one, so a deployment that sets only `TINFOIL_API_KEY`
runs entirely on that tier. What your server still records on the confidential tier is the account,
the model, timing, HTTP status, and token counts. Those counts come back from the device, because
only the device can read the response, so a modified client can under-report its own usage. It
cannot charge another account or invent a price: your server fixes who, which model, and at what
rate before the request goes out.

Chat turns on both tiers are metered against rolling per-user spend caps, and a model with no
configured price is refused rather than served for free. Voice transcription and speech run over the
same confidential route but are not metered or charged against those caps. See
[spending limits](../self-hosting/configuration.md#spending-limits).

## Telemetry

Two independent switches, and both must be on before anything is sent.

| Switch                                              | Default                                                    |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `POSTHOG_API_KEY` on the server                     | Unset. No key means no analytics client exists in the app. |
| **Anonymous Usage Data**, the user's own preference | Off. Settings → Preferences → Help Thunderbolt Improve.    |

Events are sent to your server and relayed from there, so the app never contacts an analytics host
directly and you can block the egress at your firewall. Where your server forwards them is
`POSTHOG_HOST`, which defaults to PostHog's US cloud; point it at your own instance if you run
one.

What is never collected: prompts, model responses, API keys, search queries, file names, file
contents, skill or agent names, or the text of anything a user wrote. Events carry event names and
single values such as a model identifier, a provider name, a character count, and timings. URLs are
reduced to a route pattern with query strings and fragments removed, and any property literally
named `apiKey` is stripped as the last step before sending. Automatic collection is off entirely:
no click capture, no pageviews, no session recording, no surveys, no performance capture. An error
the app handles is reported with its code, message and stack trace.

Your server adds events of its own for managed inference: one per generation on the direct tier,
carrying the model, provider, latency, HTTP status and token counts, and one when an upstream fails,
carrying the error class plus any code or request id the provider returned. Neither carries request
or response content.

Every event the app can send is listed in the published
[telemetry disclosure](https://github.com/thunderbird/thunderbolt/blob/main/TELEMETRY.md).

## What an administrator can and cannot see

Thunderbolt ships no administrator console, and no screen in the product shows one user another
user's conversations. What follows is about direct access to your own database and logs.

**You can see**

- Account records: email address, sign-in sessions, and the list of registered devices with their
  names and last-seen times.
- Managed inference usage per account: model, token counts, and cost.
- Server logs and traces: request paths, status codes, and the hostnames of upstreams a proxied
  request reached.
- With sync on and encryption off, everything a user synced, including message content.

**You cannot see**

- Provider API keys, tool server credentials, or external agent credentials. They are never uploaded.
- Uploaded file contents. They are never uploaded to your server for storage.
- Prompts or responses on the confidential inference tier.
- Encrypted content when `E2EE_ENABLED` is on, including messages, with no way to recover it for a
  user who loses every device and their recovery phrase.
- Anything on a device whose owner never enabled sync.

## What a user controls

| Action                   | Where                         | Effect                                                                                                                       |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Turn sync on or off      | Settings → Preferences → Data | Off keeps everything local to that device                                                                                    |
| Approve or deny a device | Settings → Devices            | With encryption on, an unapproved device cannot decrypt anything                                                             |
| Revoke a device          | Settings → Devices            | Ends its sessions and deletes its copy of the content key. The user chooses whether the local data is wiped                  |
| Export data              | Settings → Preferences → Data | A single JSON file with chats, settings, models, skills, and configuration                                                   |
| Delete account           | Settings → Preferences → Data | Permanently deletes the account record on the server and everything synced with it. Other signed-in devices clear themselves |
| Delete all local data    | Settings → Preferences → Data | Clears this device only. The account and anything already synced are untouched                                               |

An export file contains the user's provider API keys, tool server credentials, external agent keys
and connected-account tokens in plain text, and it is not encrypted at rest. Treat it as a secret.
Attached file contents are the one thing it does not include.

## Hardening a deployment

| Do this                                                               | Why                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Replace every credential in the evaluation Compose file               | It ships a fixed PowerSync secret, OIDC client secret and Postgres password so the stack starts unattended |
| Generate `BETTER_AUTH_SECRET` with `openssl rand -hex 32`             | It signs sessions and is the one value with no default                                                     |
| Set `CORS_ORIGINS` to your exact origins                              | Wildcards are not accepted, and the default only covers local evaluation                                   |
| Leave `RATE_LIMIT_ENABLED` at `true`                                  | Sign-in and inference limits protect spend and accounts                                                    |
| Set `TRUSTED_PROXY` only if you know what fronts the server           | The wrong value lets a client claim any IP and walk past those limits                                      |
| Set `WAITLIST_AUTO_APPROVE_DOMAINS` to your own domains               | Otherwise new users get a waitlist email instead of a sign-in code                                         |
| Set `MONITORING_TOKEN`                                                | The deeper health checks refuse to run without it                                                          |
| Turn on `E2EE_ENABLED` before onboarding users                        | Rows synced before you enable it stay readable                                                             |
| Rotate `POWERSYNC_JWT_SECRET` to cut off every outstanding sync token | Individual sync tokens cannot be revoked. They expire an hour after issue by default                       |

Full variable reference: [Configuration](../self-hosting/configuration.md).

## Reporting a vulnerability

Report privately through the
[security advisory form](https://github.com/thunderbird/thunderbolt/security/advisories/new). Do not
open a public issue. Triage, questions, and the fix confirmation all happen in the advisory thread,
and you are credited when it is published unless you ask otherwise.

Two areas take attacker-influenced input by design and are the most interesting targets: the
request forwarder, which fetches a URL the client supplies, and the optional end-to-end encryption.
Known non-findings: the published credentials in the evaluation Compose file, and plaintext
server-side storage when `E2EE_ENABLED` is off. Third-party services a deployment is pointed at,
including model providers and identity providers, are out of scope here; report those to their
owners.

Test against your own deployment or your own account. Do not read other people's data or degrade
the service for others.
