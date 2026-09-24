# Security and Privacy

What Thunderbolt stores, what leaves your infrastructure, and what you can and cannot see as the
operator of a deployment.

> **End-to-end encryption is a preview feature** and has not had a cryptography audit.

## The short version

Conversations live on each device first, and reach your server only once sync is on for that device. With
sync on and encryption off you can read a user's chats from your database; with encryption on you
cannot. Provider API keys stay on the device that entered them and never reach your server or
another device. Uploaded files stay on the device too, and are sent only inside the request that
answers that turn.

A prompt goes to whichever model provider answers it, and to a web search provider if the model
searches. Nothing goes to the Thunderbolt team by default: analytics need both a key you configure
and a user who opts in.

## Where data lives

| Data                                                            | On the device | On your server                      |
| --------------------------------------------------------------- | ------------- | ----------------------------------- |
| Chats, messages, tasks, skills, projects, automations, settings | Always        | Only when the user enables sync     |
| Model configuration (names, endpoints, tuning)                  | Always        | Only when the user enables sync     |
| External agent entries (name, address, description)             | Always        | Only when the user enables sync     |
| The device list (names, last-seen times)                        | Always        | Once the device registers for sync  |
| Provider API keys                                               | Always        | Never                               |
| Tool server addresses and their credentials                     | Always        | Never                               |
| External agent credentials                                      | Always        | Never                               |
| Uploaded files (PDFs, images, documents)                        | Always        | Never                               |
| Account record and sign-in sessions                             | No            | Always                              |
| Managed inference usage (model, token counts, cost)             | No            | Always, when you run managed models |

A **tool server** here means an MCP server: a small service a user points the app at so the model can
call its tools.

Every device keeps a full local database and reads and writes there first, so the app works offline
once the user is signed in. Sync is per device and off by default, but signing in through the in-app
sign-in modal turns it on: silently when encryption is off, and by opening the device-setup wizard
when it is on. With `POWERSYNC_URL`
unset there is no sync at all and your server never receives conversation data. Even with sync on,
uploaded file contents, provider API keys, and tool server and external agent credentials never
leave the device: a file attached on a laptop is not readable from the same account's phone, and a
tool server has to be added again on each device.

## End-to-end encryption

Off by default. We recommend turning it on before your first users sign in, because rows synced
in plain text stay that way:

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

Before upload the device encrypts message content, chat titles, task text, saved prompts, skill
text, project names, descriptions and instructions, setting values, model names and endpoints and
descriptions, per-model tuning overrides, and automation schedule times. Anything not in that list
syncs as plain text.

Record ids, timestamps, relationships, ordering, deletion markers and on/off flags stay readable on
the server. So do device names, which the app sends in a header on every sync-token request, and
external agent entries: an agent's name, address, description and icon sync in the clear. The external agent gap is a known omission rather than a design decision, and a fix is
planned.

**Limits worth knowing before you commit**

- Encryption covers what is synced, not what the model provider sees: the prompt is decrypted on the
  device and sent to the provider that answers it.
- Turning encryption on later does not re-encrypt rows already synced in plain text.
- A user is capped at 10 trusted devices per account.
- No cryptography audit yet.

> With encryption off, the server auto-trusts each device: no approval step, no recovery phrase, and
> your database holds readable conversation content.

## What leaves your deployment

| Destination                                    | What it receives                                                                                                                           | How to stop it                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Model providers the user adds                  | The prompt, conversation history, and attachments, plus the user's own API key                                                             | Point users at a local model server instead                                                                                                     |
| Tool servers and external agents the user adds | An MCP server gets the arguments of each tool call; an external agent gets the conversation it answers. Both get the user's own credential | `ALLOW_CUSTOM_AGENTS=false` hides the add-agent control; it is not enforced server-side. MCP servers have no equivalent switch                  |
| Managed models you configure                   | Depends on the tier, see below                                                                                                             | Leave the provider keys unset                                                                                                                   |
| Exa (web search, page fetch)                   | The search query, and the URL of any page the model reads                                                                                  | Leave `EXA_API_KEY` unset and neither tool can call out. A user can also switch the **Thunderbolt** connection off under Settings → Connections |
| Open-Meteo                                     | A place name or coordinates, for location search and weather                                                                               | Not separately configurable today                                                                                                               |
| Resend                                         | The recipient address for sign-in codes and waitlist mail                                                                                  | Leave `RESEND_API_KEY` unset, which also disables email sign-in                                                                                 |
| PostHog                                        | Product analytics, never prompt or response content                                                                                        | Leave `POSTHOG_API_KEY` unset                                                                                                                   |
| The Thunderbolt team                           | Nothing, unless you configure debug transcript forwarding                                                                                  | Leave `DEBUG_TRANSCRIPT_UPSTREAM_URL` unset, which is the default                                                                               |

Requests to a user-added provider or tool server pass through your server, because a browser cannot
call most provider APIs directly. Your server forwards the bytes and the user's credential untouched
and stores neither. Access logs record the upstream hostname, not the full URL, so a user's browsing
is not written into your logs. A model server on the user's own machine, such as Ollama or LM
Studio, is the exception: your server cannot reach it, so the app calls it directly and nothing
about those turns crosses your infrastructure.

Your server also fetches pages itself, with no user credential attached, to build link previews:
a link a user pastes or a model returns becomes a request from your infrastructure to that site.

> If you turn on debug transcript forwarding, a transcript carries the whole conversation plus the
> user id and email your deployment holds. The Thunderbolt team retains it, and it survives deletion
> of the submitting account.

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
runs entirely on that tier. On the confidential tier your server still records the account, the
model, timing, HTTP status, and token counts. Those counts come back from the device, because only
the device can read the response, so a modified client can under-report its own usage. It cannot
charge another account or invent a price, because your server fixes the account, the model, and the
rate before the request goes out.

Chat turns on both tiers are metered against rolling per-user spend caps, and a model with no
configured price is refused rather than served for free. Voice transcription and speech run over the
same confidential route but are not metered or charged against those caps. See
[spending limits](../self-hosting/configuration.md#spending-limits).

## Telemetry

Two independent switches, and both must be on before anything is sent. `POSTHOG_API_KEY` on the
server is unset by default, and no key means no analytics client exists in the app. The user's own
preference, **Anonymous Usage Data**, starts off under Settings → Preferences → Help Thunderbolt
Improve.

Events are sent to your server and relayed from there, so the app never contacts an analytics host
directly and you can block the egress at your firewall. Where your server forwards them is
`POSTHOG_HOST`, which defaults to PostHog's US cloud; point it at your own instance if you run
one.

We never collect prompts, model responses, API keys, search queries, file names, file
contents, skill or agent names, or the text of anything a user wrote. Events carry event names and
single values such as a model identifier, a provider name, a character count, and timings. URLs are
reduced to a route pattern with query strings and fragments removed, and any property literally
named `apiKey` is stripped as the last step before sending. Automatic collection is off entirely: no
click capture, no pageviews, no session recording, no surveys, no performance capture. An error the
app handles is reported with its code, message and stack trace.

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

- Provider API keys, tool server credentials, or external agent credentials. None are ever uploaded.
- Uploaded file contents, which never reach your server for storage.
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

An export file does not include attached file contents.

> It does contain the user's provider API keys, tool server credentials and external agent keys in
> plain text, and it is not encrypted at rest. Treat it as a secret. Google and Microsoft tokens are
> the one credential class left out; the user re-authorizes those on the new device.

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
[security advisory form](https://github.com/thunderbird/thunderbolt/security/advisories/new). Don't
open a public issue. Triage, questions, and the fix confirmation all happen in the advisory thread,
and you are credited when it is published unless you ask otherwise.

Two areas are meant to take attacker-influenced input and are the most interesting targets: the
request forwarder, which fetches a URL the client supplies, and the optional end-to-end encryption.
Known non-findings: the published credentials in the evaluation Compose file, and plaintext
server-side storage when `E2EE_ENABLED` is off. Third-party services a deployment is pointed at,
including model providers and identity providers, are out of scope here; report those to their
owners.

Test against your own deployment or your own account. Don't read other people's data, and don't
degrade the service for others.
