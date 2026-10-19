# Public agent on Render

A public agent deployment is Thunderbolt for visitors who never sign in: each one gets an anonymous session and chats with a single agent you configure, for example at an event. It is built from the Render Blueprint in [`deploy/render/public-agent.yaml`](../../deploy/render/public-agent.yaml). Nothing about a particular deployment lives in the repository; every per-deployment value is entered in Render.

## What it runs

| Resource | Name in the Blueprint | Notes                                                                                                      |
| -------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Web app  | `public-agent-web`    | Static site built from `main`. Sends the headers the app needs and refuses to be framed (see below).       |
| API      | `public-agent-api`    | Node service from `backend/`, one instance running one process (see Limits), health check on `/v1/health`. |
| Database | `public-agent-db`     | Its own PostgreSQL, reachable only from inside Render.                                                     |

There is no sync service. Anonymous sessions never sync, and the API runs without one when `POWERSYNC_URL` is unset, so visitors' chats stay in their browsers.

## Before you start

- Access to the Render workspace and the Thunderbolt project.
- An API key for the agent's model, used by this deployment only: Anthropic for `claude-opus-5-5`, Fireworks for the Fireworks models (see `AGENT_MODEL` below). Ideally it lives in its own workspace with a spend limit, so a leak or a burst cannot touch production.
- A Tinfoil API key used by this deployment only, if you keep the built-in agent on. Its default model runs on Tinfoil.
- Two hostnames, one for the app and one for the API, for example `agent.example.com` and `agent-api.example.com`. If Cloudflare proxies them, keep each one level below the zone so the universal certificate covers it.
- Optionally, a PostHog project of its own for product analytics. Never reuse production's.

## Deploy

1. In the Render dashboard choose **New > Blueprint**, pick `thunderbird/thunderbolt` and the `main` branch, and set **Blueprint Path** to `deploy/render/public-agent.yaml`.
2. Enter the values Render asks for (next section) and apply. Render creates the three resources.
3. Create an environment for the deployment under the Thunderbolt project and move the three resources into it. Render keeps a resource's environment across later syncs.
4. Add the app hostname as a custom domain on `public-agent-web` and the API hostname on `public-agent-api`, point a CNAME at each, and wait for the certificates.
5. Turn off each service's `onrender.com` subdomain, so the custom hostnames are the only way in. The Blueprint cannot, because it names no domain.
6. Check that `https://<api host>/v1/health` returns `{"status":"ok"}`, then open the app.

## Values Render asks for

Render prompts once for every value below and never overwrites them afterwards. Change them later on the service.

| Setting                                                                                      | What to enter                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL`                                                                 | `https://<api host>/v1`. It is built into the app, so changing it means a rebuild.                                                                                                             |
| `APP_URL`, `CORS_ORIGINS`                                                                    | `https://<app host>`                                                                                                                                                                           |
| `BETTER_AUTH_URL`                                                                            | `https://<api host>`                                                                                                                                                                           |
| `ANTHROPIC_API_KEY`                                                                          | The deployment's own key, when `AGENT_MODEL` is an Anthropic model.                                                                                                                            |
| `TINFOIL_API_KEY`                                                                            | The deployment's own key, while the built-in agent is on: chats on its default model fail without it. Blank once it is off.                                                                    |
| `FIREWORKS_API_KEY`                                                                          | The deployment's own key, when `AGENT_MODEL` is a Fireworks model.                                                                                                                             |
| `POSTHOG_API_KEY`, `POSTHOG_HOST`                                                            | The deployment's own project, or blank for no analytics.                                                                                                                                       |
| `AGENT_ENABLED`                                                                              | `true` to mount the hosted agent.                                                                                                                                                              |
| `DISABLE_BUILT_IN_AGENT`                                                                     | `true`, so visitors chat only with the hosted agent.                                                                                                                                           |
| `MINIMAL_MODE`                                                                               | `true`, for the chat-only app described below.                                                                                                                                                 |
| `ENABLED_AGENTS`                                                                             | `hosted-agent`, so discovery offers only the hosted agent.                                                                                                                                     |
| `AGENT_MODEL`                                                                                | `claude-opus-5-5` (Anthropic), `accounts/fireworks/models/glm-5p3` or `accounts/fireworks/models/minimax-m3` (Fireworks). The API refuses to start on any other id.                            |
| `AGENT_SYSTEM_PROMPT`                                                                        | The agent's knowledge (next section).                                                                                                                                                          |
| `AGENT_NAME`, `AGENT_DESCRIPTION`, `AGENT_ICON`                                              | How the agent is presented.                                                                                                                                                                    |
| `AGENT_TIMEZONE`                                                                             | The venue's IANA time zone, such as `Europe/London`, for the date and hour the agent is told. UTC when blank.                                                                                  |
| `AGENT_MCP_SERVERS`                                                                          | The MCP servers whose read-only tools the agent may call, as JSON (see [Hosted agent tools](./configuration.md#hosted-agent-tools)). Give each one `allowedTools`. Blank for none.             |
| `AGENT_MAX_STEPS`                                                                            | Blank keeps 8 model steps per reply. At most 21.                                                                                                                                               |
| `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS`, `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS`                   | Each visitor's spending cap, in cents. Enter numbers: a blank value stops the API at startup.                                                                                                  |
| `ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX`, `ANONYMOUS_SIGN_IN_RATE_LIMIT_WINDOW_SECS`               | Blank keeps the defaults, 10 per 60 seconds. Without a captcha provider the API refuses to start with more than 10 or a window under 60 seconds.                                               |
| `ANONYMOUS_SIGN_IN_GLOBAL_RATE_LIMIT_MAX`, `ANONYMOUS_SIGN_IN_GLOBAL_RATE_LIMIT_WINDOW_SECS` | Blank keeps the defaults, 2000 per 3600 seconds across the whole deployment. Size it to the visitors you expect: once it runs out, no new visitor can start a session until the window resets. |
| `ANONYMOUS_USER_IDLE_DAYS`                                                                   | Blank keeps the default, 30 days: a visitor idle that long is deleted with their usage records. Enter `0` to keep every visitor until teardown.                                                |
| `VITE_CAPTCHA_PROVIDER`                                                                      | `altcha` to turn on the captcha, or blank. Set it together with `CAPTCHA_PROVIDER`: both or neither. A change means a rebuild.                                                                 |
| `CAPTCHA_PROVIDER`                                                                           | `altcha` together with `VITE_CAPTCHA_PROVIDER`, or blank for none. See [ALTCHA](./configuration.md#altcha).                                                                                    |
| `ALTCHA_SECRET`                                                                              | With `altcha`, a key of at least 32 characters: `openssl rand -hex 32`. Otherwise blank.                                                                                                       |

The rest is fixed by the Blueprint. On the API it turns on anonymous sessions (`AUTH_ALLOW_ANONYMOUS=true`), lets them discover the agent (`ALLOW_ANONYMOUS_AGENT_DISCOVERY=true`) and stops users adding their own agents (`ALLOW_CUSTOM_AGENTS=false`). It also sets `TRUSTED_PROXY=cloudflare`: all traffic to a Render web service passes through Cloudflare, which writes the caller's address to `CF-Connecting-IP`, so the rate limits key on each visitor's own address. Without it the API sees Render's proxy as every visitor, and they all share one sign-in budget. The app is built with `VITE_AUTH_ENABLE_ANONYMOUS`, `VITE_BYPASS_WAITLIST` and `VITE_SKIP_ONBOARDING`, so a visitor lands straight in a chat. `BETTER_AUTH_SECRET` is generated. Every setting is described in [Configuration](./configuration.md).

With `MINIMAL_MODE=true` the app is a chat and nothing else: no Settings section (`/settings` links return to the chat), no Projects, no agent name in the header, no pinned skill chips above the composer, no account or sync control, and no Settings destinations in search.

## The agent's knowledge

| Kind of knowledge                              | Where it goes                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fixed material: an FAQ, venue facts, policies  | `AGENT_SYSTEM_PROMPT`. It is sent with every request, so write facts, not prose. Keep the source out of this repository. |
| Data that changes: a schedule, rooms, speakers | An MCP server listed in `AGENT_MCP_SERVERS`, whose read-only tools the agent calls while it answers.                     |

Visitors' project and skill instructions are appended after `AGENT_SYSTEM_PROMPT`, under a header that ranks them below it. That ranking is a request to the model, not an enforced rule, so treat the prompt as readable by visitors and not as a hard guardrail.

The agent is told the current date and hour in `AGENT_TIMEZONE`, so with a schedule tool it can answer questions such as "what's on this afternoon?".

## Headers

The web app sends `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin`. They make the page cross-origin isolated, which the app's local database needs, so a site without them does not start. It also sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`, because nothing embeds a public agent.

## Usage report

The API can report users, turns, tokens and spend for any window, split between anonymous and signed-in users, by day and by model, with the busiest hour. It reports counts only. Run it in an SSH session on the API (`render ssh`), from the `backend` directory:

```bash
bun run usage-report --from 2026-10-26 --to 2026-11-02 --tz Europe/London
```

`--from` is inclusive and `--to` exclusive. Add `--json` for machine-readable output. Usage rows are deleted along with their user, and the API deletes each visitor about `ANONYMOUS_USER_IDLE_DAYS` days (default 30) after their own last activity, so a visitor who left on the first day can be gone before a report run weeks later. For an event, set it to `0` until the report has been run, or to at least the event's length plus the days until the report runs.

## Freeze before the event

Every merge to `main` redeploys the deployment while auto-deploy is on. A few days before the event:

1. On the Blueprint's settings page, set **Auto Sync** to **No**.
2. Turn **Auto-Deploy** off on both services.
3. Deploy the commit you tested to each service: `render deploys create <service id> --commit <sha>`.

Ship a fix during the event the same way, by deploying its commit.

## Teardown

1. Run the usage report and keep the output.
2. Disconnect the Blueprint. While it is connected, Render recreates a deleted resource on the next sync.
3. Delete both services and the database.

Before teardown, the API already deletes each visitor about `ANONYMOUS_USER_IDLE_DAYS` days after their last activity, with their sessions and usage records (see [Anonymous sign-in](./configuration.md#anonymous-sign-in)). Keep it at `0` until the usage report has been run, or at least the event's length plus the days until the report runs. Deleting the database removes everything the deployment kept on the server: the anonymous accounts and sessions, the usage records and the rate-limit counters. The server keeps no conversations, since the hosted agent is stateless and nothing syncs, but visitors' questions reach the MCP servers in `AGENT_MCP_SERVERS` as tool inputs, so check what those servers log. Visitors' chats stay in their browsers until they clear the site's data. PostHog data, if you collected any, lives in that project and is removed there.

## Limits

- One live deployment of the Blueprint per Render workspace, because its resource names are fixed.
- Without a captcha provider, anonymous sign-in allows at most 10 per IP address per minute. Venue Wi-Fi, where many visitors share a few addresses, reaches that quickly. Setting both `CAPTCHA_PROVIDER` and `VITE_CAPTCHA_PROVIDER` to `altcha` lifts the ceiling; see [ALTCHA](./configuration.md#altcha).
- On top of that, the whole deployment admits 2000 anonymous sign-ins an hour by default (`ANONYMOUS_SIGN_IN_GLOBAL_RATE_LIMIT_MAX`).
- The hosted agent calls one model, on Anthropic or Fireworks (see `AGENT_MODEL` in [Configuration](./configuration.md#hosted-agent)), and uses only the tools its MCP servers mark read-only, at most 20 calls per reply.
- A reply that a visitor stops, or that hits the 2-minute limit, usually ends before the provider reports its token usage. It is charged against the visitor's spending cap at what its finished steps reported, plus an estimate for the step in flight that errs high, and the usage row does not mark it as one ([Configuration](./configuration.md#hosted-agent)).
- The spending cap is checked before each reply, so a reply that uses tools can go past it by up to its own cost, and the visitor's next message is refused.
- The API runs as one instance with one process (`WEB_CONCURRENCY=1`). The hosted agent allows a visitor one run at a time but tracks that per process, so scaling out would let parallel runs exceed the spending cap. Scale out once the agent has a shared run lock.
