# Monitoring

Thunderbolt exposes one public liveness endpoint for load balancers and four token-protected probes that test each dependency for real. It writes logs to standard output and can send traces to any OpenTelemetry collector. There is no metrics endpoint and no dashboard, and nothing polls those endpoints or raises an alert on its own, so you point your own tooling at them.

## Where to start

Point your load balancer at `/v1/health`. It needs no token, and it gives the balancer a way to restart a wedged API process. Then set `MONITORING_TOKEN` and poll the deep probes. We recommend `/v1/health/database` and `/v1/health/powersync` every minute, and `/v1/health/email` every 15 minutes. The most common real outage is the database, not the API. Sync failing is invisible to users until they open a second device, and a broken sending domain locks everyone out of email sign-in.

Ship the container logs somewhere durable too. The services write nothing to disk, so logs live only in your container platform's buffer and go when the container is removed.

## Health endpoints

| Endpoint                   | Auth             | What it proves                                                                                        |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /v1/health`           | none             | The API process is accepting requests.                                                                |
| `GET /v1/health/database`  | monitoring token | A query reached PostgreSQL and came back. 5 second deadline.                                          |
| `GET /v1/health/powersync` | monitoring token | The sync service answered its own liveness probe. 5 seconds.                                          |
| `GET /v1/health/email`     | monitoring token | The email provider accepted the key and the sending domain is verified. 10 seconds. No email is sent. |
| `GET /v1/health/models`    | monitoring token | Every model your server supplies a key for answered a real request.                                   |

`GET /v1/health` returns `{"status":"ok"}` and touches no dependency, so a green response tells you the process is alive and nothing about whether anyone can sign in or send a message.

All health endpoints are exempt from the minimum app version gate, so they keep answering after you set `MIN_APP_VERSION`.

## Load balancer and orchestrator probes

Each supported deployment already wires these up.

| Deployment     | API service                                                         | App                | Sync service                 |
| -------------- | ------------------------------------------------------------------- | ------------------ | ---------------------------- |
| Kubernetes     | `/v1/health` readiness and liveness on port `8000`                  | `/` on port `8080` | TCP check on port `8080`     |
| AWS            | `/v1/health` load balancer check, every 30s                         | `/` every 30s      | `/probes/liveness` every 30s |
| Docker Compose | Starts only once PostgreSQL and the bundled Keycloak report healthy | n/a                | n/a                          |

If you put your own proxy in front, give the API service two minutes of grace on first start: it waits up to 90 seconds for the database, then applies migrations, then begins listening.

## Deep health checks

The four probes stay off until a monitoring token is set.

```bash
MONITORING_TOKEN=$(openssl rand -hex 32)
```

Call them with a bearer token:

```bash
curl -H "Authorization: Bearer $MONITORING_TOKEN" \
  https://thunderbolt.example.com/v1/health/database
```

| Response                                          | Meaning                                    |
| ------------------------------------------------- | ------------------------------------------ |
| `200 {"status":"ok"}`                             | Healthy.                                   |
| `503 {"status":"failed","reason":"<code>"}`       | The dependency is down. Reasons below.     |
| `401 {"error":"Unauthorized"}`                    | Wrong or missing token. No probe was run.  |
| `403 {"error":"Monitoring token not configured"}` | `MONITORING_TOKEN` is unset on the server. |

An unauthenticated caller never causes a probe to run, so the endpoints cannot be used to hammer your database or spend money on model calls.

### Failure reasons

| Reason              | Applies to            | What it means                                                                                    |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `timeout`           | all                   | The dependency did not answer inside the deadline.                                               |
| `unreachable`       | database, sync, email | Anything that is not a timeout: refused connection, DNS, bad credentials, or a missing database. |
| `not-configured`    | sync, email           | `POWERSYNC_URL` or `RESEND_MONITORING_API_KEY` is unset.                                         |
| `http-<code>`       | sync, email           | The dependency answered, with an error status.                                                   |
| `rejected`          | email                 | The email provider refused the key. Usually a sending-only key, or a revoked one.                |
| `domain-unverified` | email                 | The sending domain is missing from your provider account, or not verified yet.                   |

The email probe asks the provider for your verified sending domains, so it needs a key with read access to that list. Keep `RESEND_API_KEY` sending-only and give the probe its own `RESEND_MONITORING_API_KEY`. It looks for the fixed sender domain `auth.thunderbolt.io`, which no setting changes, so the probe is red until that domain is verified on the account the key belongs to.

### The models probe

`GET /v1/health/models` sends one small request to every model Thunderbolt ships preconfigured, three at a time, with a 20 second deadline each and no retries. Don't poll it more than a few times an hour: it is the only probe that spends money. We recommend every 15 minutes.

```json
{ "status": "failed", "failures": [{ "model": "glm-5-3", "reason": "no-text" }] }
```

| Reason           | What it means                                                            |
| ---------------- | ------------------------------------------------------------------------ |
| `no-text`        | The model answered with an empty response.                               |
| `timeout`        | No answer within 20 seconds.                                             |
| `upstream-error` | The provider returned an error. Usually a bad or exhausted key.          |
| `missing-price`  | The model has no price on record, so the server refuses requests for it. |
| `not-configured` | No provider key is set on the server for that model.                     |

Failure entries never contain the upstream response body or your credentials.

The probe exercises only the models your deployment is configured to serve; models your users add themselves are not covered.

> Don't alert on this endpoint unless your server holds **both** `ANTHROPIC_API_KEY` and `TINFOIL_API_KEY`. The probe walks the whole preconfigured catalog, a model with no key reports `not-configured`, and one failure fails the check, so a partly-keyed server stays red however healthy it is.

## What to alert on

| Signal                                       | Severity                                | Reasoning                                                                                                                                                           |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/health` failing for 1 minute            | page                                    | The API is down. Everything else follows.                                                                                                                           |
| `/v1/health/database` failing for 2 minutes  | page                                    | Sign-in, sync and settings all stop.                                                                                                                                |
| `/v1/health/powersync` failing for 5 minutes | page                                    | Writes still upload through the API, so new content reaches the database and your backups. Only downloads to a user's other devices stop, and they will not notice. |
| `/v1/health/email` failing                   | page in consumer mode, ignore under SSO | Emailed codes are the only way to create a new session under `AUTH_MODE=consumer`. Existing sessions and personal access tokens keep working.                       |
| `/v1/health/models` failing                  | ticket                                  | Affects the preconfigured models only, and usually resolves upstream.                                                                                               |
| API restart loop                             | page                                    | Almost always a bad configuration value or an unreachable database. The startup log says which.                                                                     |
| A sustained rise in `429` responses          | ticket                                  | The limits themselves are not configurable. A steady stream means a client is misbehaving or your team has outgrown them.                                           |
| A sustained rise in `5xx` responses          | ticket                                  | Check the API log for the failing route.                                                                                                                            |
| `426` responses appearing                    | ticket                                  | You set `MIN_APP_VERSION` and clients below it are locked out. Expected during a forced upgrade, a bug otherwise.                                                   |

## Logs

Every service writes to standard output. Nothing is written to a log file, so collection is your container platform's job.

| Deployment     | Where logs land                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker Compose | `docker compose logs -f backend`. Lost when the container is removed.                                                                                                                            |
| Kubernetes     | `kubectl logs -n thunderbolt deploy/backend`. Forward to your cluster's log stack.                                                                                                               |
| AWS            | On the Fargate target, one CloudWatch log group per stack, **retained for 7 days**. Raise it if you need longer. On the EKS target, logs land in the cluster like any other Kubernetes workload. |

API logs are structured JSON when `NODE_ENV=production` and human-readable when it is not. `LOG_LEVEL` accepts `DEBUG`, `INFO`, `WARN` or `ERROR` and defaults to `INFO`.

Request lines use the Apache common log format with a response time appended:

```
203.0.113.7 - "POST /v1/proxy HTTP/1.1" 200 OK 412ms
```

The client address is the connecting socket unless `TRUSTED_PROXY` is set to `cloudflare` or `akamai`. Behind a load balancer and without it, every line shows the balancer's address. Don't set it unless you know exactly what sits in front of the server. Trusting the wrong header lets any client claim any IP and walk straight past the rate limits.

Requests to `/v1/health`, to static assets, and to the analytics proxy under `/v1/posthog/` (its config request aside) are not access-logged, so load balancer traffic will not drown the log. The deep probes under `/v1/health/` are logged like any other request.

### What is never in a log

Message content, prompts and model responses never reach a log; calls to AI providers are recorded by hostname only. Provider API keys, session cookies and bearer tokens are never logged either, and neither are the contents of any file a user attaches.

There is one exception.

> If no email service is configured and the server is not running in production mode, sign-in codes and sign-in links are written to the log instead of being emailed. That is the intended local evaluation setup. Configure an email service before real users reach the deployment.

### Startup lines

The API prints its configuration decisions when it starts. Two are easy to miss:

- A warning that the email key is unset. Outside production mode this means sign-in codes go to the log instead of the user's inbox; in production mode email sign-in fails outright with an "Email service not configured" error.
- The address and port it bound to, which is the fastest way to confirm `PORT` and `HOST` took effect.

## Traces

Point the server at an OpenTelemetry collector and it sends traces automatically.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
OTEL_EXPORTER_OTLP_TOKEN=your-collector-token
```

Leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset and tracing is off entirely, with nothing loaded and no overhead. The token is optional and sent as a bearer token, for collectors that require one. Any OTLP collector works; we test with BetterStack.

## Not provided

Thunderbolt exposes no Prometheus metrics and no `/metrics` endpoint, so dashboards have to come from your platform's container metrics and from traces. Alerting is not built in either: the endpoints are there, and the polling, thresholds and paging are yours. Health endpoints report the present moment and store nothing, so nothing on the server holds uptime history.

Nothing aggregates usage for an administrator. Conversation rows do reach the database for every user who turns sync on, but no endpoint or dashboard summarizes them, and although spend on the preconfigured models is recorded per request, nothing renders that for an administrator either.

Nothing verifies your backups. Monitoring that your PostgreSQL backups exist and restore is your responsibility, and those backups hold every account and the synced copy of every conversation from users who turned sync on.

## Related

- [Configuration](./configuration.md) for every setting named on this page.
- [Backup and restore](./backup-and-restore.md) for verifying the backups themselves.
- [Kubernetes](./kubernetes.md) and [AWS with Pulumi](./pulumi.md) for the probe settings each deployment ships with.
