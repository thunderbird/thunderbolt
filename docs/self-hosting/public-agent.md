# Public agent on Render

A public agent deployment is Thunderbolt for visitors who never sign in: each one gets an anonymous session and chats with a single agent you configure, for example at an event. It is built from the Render Blueprint in [`deploy/render/public-agent.yaml`](../../deploy/render/public-agent.yaml). Nothing about a particular deployment lives in the repository; every per-deployment value is entered in Render.

> **Not usable end to end yet.** The app does not talk to the hosted agent until its frontend adapter ships, and the agent has no tools. Until then, keep the built-in agent on (`DISABLE_BUILT_IN_AGENT=false`) so visitors can chat.

## What it runs

| Resource | Name in the Blueprint    | Notes                                                                                                |
| -------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Web app  | `public-agent-web`       | Static site built from `main`. Sends the headers the app needs and refuses to be framed (see below). |
| API      | `public-agent-api`       | Node service from `backend/`, autoscaling from one to four instances, health check on `/v1/health`.  |
| Database | `public-agent-db`        | Its own PostgreSQL, reachable only from inside Render.                                               |
| Settings | `public-agent` env group | Read by the API.                                                                                     |

There is no sync service. Anonymous sessions never sync, and the API runs without one when `POWERSYNC_URL` is unset, so visitors' chats stay in their browsers.

## Before you start

- Access to the Render workspace and the Thunderbolt project.
- An Anthropic API key used by this deployment only, ideally in its own Anthropic workspace with a spend limit, so a leak or a burst cannot touch production.
- Two hostnames, one for the app and one for the API, for example `agent.example.com` and `agent-api.example.com`. If Cloudflare proxies them, keep each one level below the zone so the universal certificate covers it.
- Optionally, a PostHog project of its own for product analytics. Never reuse production's.

## Deploy

1. In the Render dashboard choose **New > Blueprint**, pick `thunderbird/thunderbolt` and the `main` branch, and set **Blueprint Path** to `deploy/render/public-agent.yaml`.
2. Enter the values Render asks for (next section) and apply. Render creates the four resources.
3. Create an environment for the deployment under the Thunderbolt project and move the four resources into it. Render keeps a resource's environment across later syncs.
4. Add the app hostname as a custom domain on `public-agent-web` and the API hostname on `public-agent-api`, point a CNAME at each, and wait for the certificates.
5. Turn off each service's `onrender.com` subdomain. The Blueprint cannot, because it names no domain. On the API this matters: with `TRUSTED_PROXY` set, an open `onrender.com` URL lets a client skip the proxy and claim any IP address.
6. Check that `https://<api host>/v1/health` returns `{"status":"ok"}`, then open the app.

## Values Render asks for

Render prompts once for every value below and never overwrites them afterwards. Change them later on the env group or the service.

| Setting                                                                        | What to enter                                                                                      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL`                                                   | `https://<api host>/v1`. It is built into the app, so changing it means a rebuild.                 |
| `APP_URL`, `CORS_ORIGINS`                                                      | `https://<app host>`                                                                               |
| `BETTER_AUTH_URL`                                                              | `https://<api host>`                                                                               |
| `TRUSTED_PROXY`                                                                | `cloudflare` when Cloudflare proxies the hostnames, otherwise blank.                               |
| `ANTHROPIC_API_KEY`                                                            | The deployment's own key.                                                                          |
| `FIREWORKS_API_KEY`                                                            | Blank. Nothing routes to Fireworks yet.                                                            |
| `POSTHOG_API_KEY`, `POSTHOG_HOST`                                              | The deployment's own project, or blank for no analytics.                                           |
| `AGENT_ENABLED`                                                                | `true` to mount the hosted agent.                                                                  |
| `DISABLE_BUILT_IN_AGENT`                                                       | `false` for now; `true` once the app supports the hosted agent.                                    |
| `ENABLED_AGENTS`                                                               | Blank for now; `hosted-agent` once the built-in agent is off.                                      |
| `AGENT_MODEL`                                                                  | An Anthropic model with a row in the price table. `claude-opus-5` ships priced.                    |
| `AGENT_SYSTEM_PROMPT`                                                          | The agent's knowledge (next section).                                                              |
| `AGENT_NAME`, `AGENT_DESCRIPTION`, `AGENT_ICON`                                | How the agent is presented.                                                                        |
| `AGENT_MAX_STEPS`, `AGENT_MCP_SERVERS`                                         | Blank. Neither has an effect until the agent has tools.                                            |
| `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS`, `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS`     | Each visitor's spending cap, in cents. Enter numbers: a blank value stops the API at startup.      |
| `ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX`, `ANONYMOUS_SIGN_IN_RATE_LIMIT_WINDOW_SECS` | Blank keeps the defaults (10 per 60 seconds). Without a captcha provider they can only be lowered. |

The rest is fixed by the Blueprint. The env group turns on anonymous sessions (`AUTH_ALLOW_ANONYMOUS=true`), lets them discover the agent (`ALLOW_ANONYMOUS_AGENT_DISCOVERY=true`) and stops users adding their own agents (`ALLOW_CUSTOM_AGENTS=false`). The app is built with `VITE_AUTH_ENABLE_ANONYMOUS`, `VITE_BYPASS_WAITLIST` and `VITE_SKIP_ONBOARDING`, so a visitor lands straight in a chat. `BETTER_AUTH_SECRET` is generated. Every setting is described in [Configuration](./configuration.md).

## The agent's knowledge

| Kind of knowledge                              | Where it goes                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Fixed material: an FAQ, venue facts, policies  | `AGENT_SYSTEM_PROMPT`. It is sent with every request, so write facts, not prose. Keep the source out of this repository.    |
| Data that changes: a schedule, rooms, speakers | MCP servers listed in `AGENT_MCP_SERVERS`, once the agent has tools. Until then, have the prompt say where the schedule is. |

The agent is not told the current date or time yet, so questions such as "what's on this afternoon?" need the schedule tools.

## Headers

The web app sends `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin`. They make the page cross-origin isolated, which the app's local database needs, so a site without them does not start. It also sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`, because nothing embeds a public agent.

## Usage report

The API can report users, turns, tokens and spend for any window, split between anonymous and signed-in users, by day and by model, with the busiest hour. It reports counts only. Run it in an SSH session on the API (`render ssh`), from the `backend` directory:

```bash
bun run usage-report --from 2026-10-26 --to 2026-11-02 --tz Europe/London
```

`--from` is inclusive and `--to` exclusive. Add `--json` for machine-readable output. Usage rows are deleted along with their user, so run the report before removing users or the database.

## Freeze before the event

Every merge to `main` redeploys the deployment while auto-deploy is on. A few days before the event:

1. On the Blueprint's settings page, set **Auto Sync** to **No**.
2. Turn **Auto-Deploy** off on both services.
3. Deploy the commit you tested to each service: `render deploys create <service id> --commit <sha>`.

Ship a fix during the event the same way, by deploying its commit.

## Teardown

1. Run the usage report and keep the output.
2. Disconnect the Blueprint. While it is connected, Render recreates a deleted resource on the next sync.
3. Delete both services, the database and the env group.

Deleting the database removes everything the deployment kept on the server: the anonymous accounts and sessions, the usage records and the rate-limit counters. The server keeps no conversations, since the hosted agent is stateless and nothing syncs. Visitors' chats stay in their browsers until they clear the site's data. PostHog data, if you collected any, lives in that project and is removed there.

## Limits

- One live deployment of the Blueprint per Render workspace, because its resource names are fixed.
- Without a captcha provider, anonymous sign-in stays at 10 per IP address per minute by default and can only be lowered. Venue Wi-Fi, where many visitors share a few addresses, reaches that quickly.
- The hosted agent calls Anthropic only and has no tools yet.
