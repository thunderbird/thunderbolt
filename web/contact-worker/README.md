# Marketing contact Worker

The Render marketing site posts JSON to this independent Cloudflare Worker. The
Worker validates the inquiry and sends one internal notification through Resend.
It has no Thunderbolt app/backend dependency or account system. One Durable Object
stores only the short-lived rate-limit budget. The
website remains a Render **Static Site**.

## First deployment

Use a checkout containing this change. Commands below start at the repository root.
Wrangler is installed in this package; no global Cloudflare CLI installation is needed.

### 1. Prepare Resend

In Resend, verify the sending domain and create a **sending-only API key**, ideally
restricted to that domain and dedicated to the marketing form. Choose:

- `EMAIL_FROM`: a bare address on that verified domain, such as `website@thunderbolt.io`.
- `CONTACT_EMAIL_TO`: the actual team inbox that should receive inquiries. There is no default.
- `RESEND_API_KEY`: the new sending key.

The visitor's email becomes Reply-To. Visitors cannot choose a recipient, sender,
subject, attachment, or autoresponder.

### 2. Create the Worker

```sh
cd web/contact-worker
bun install --frozen-lockfile
bunx --no-install wrangler login
bun run deploy
```

Login opens Cloudflare in your browser. Select the account that should own the
marketing Worker. If multiple accounts are available, set `CLOUDFLARE_ACCOUNT_ID`
to the intended account ID before deploying. Wrangler may ask you to choose your
account's `workers.dev` subdomain on the first deployment.

The deployment prints a URL like
`https://thunderbolt-contact.YOUR-SUBDOMAIN.workers.dev`.
This first deployment refuses submissions with 503 until all three secrets exist.
No changes to DNS, Render hosting, or the app backend are needed.

The IP burst-limit namespace ID in `wrangler.jsonc` must be unused by other
Workers in the account. Change it before deployment if it already exists.
Wrangler also creates the SQLite-backed `ContactRateLimiter` Durable Object.
Keep its class and singleton name stable across deployments to preserve the budget.
This package's Wrangler version uses Cloudflare's [declarative Durable Object
`exports`](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
configuration, which replaces the legacy `migrations` array. Do not configure both.
The `storage: "sqlite"` declaration creates the namespace on the first real deploy.

### 3. Set the three Worker secrets

Run each command and enter its value at the hidden prompt:

```sh
bunx --no-install wrangler secret put RESEND_API_KEY
bunx --no-install wrangler secret put EMAIL_FROM
bunx --no-install wrangler secret put CONTACT_EMAIL_TO
```

These commands update the deployed Worker. Secrets persist across later code
deployments. Do not put their values in `wrangler.jsonc`, GitHub, or Render's static
site environment. They can also be managed under the Worker's Settings → Variables
and Secrets in Cloudflare.

### 4. Connect Render

On **thunderbolt-marketing → Environment**, set this **build-time** variable:

```text
PUBLIC_CONTACT_ENDPOINT=https://thunderbolt-contact.YOUR-SUBDOMAIN.workers.dev/api/contact
```

Use the URL printed by Wrangler, with `/api/contact` appended. Save and rebuild the
marketing site from the code in this change. Keep its service type as Static Site.
The production Worker accepts exactly `https://www.thunderbolt.io` and
`https://thunderbolt.io`. Additional sites need explicit origins in `wrangler.jsonc`
and a Worker deployment; do not use wildcard origins or add all PR previews.

After switching, remove `RESEND_API_KEY`, `EMAIL_FROM`, and `CONTACT_EMAIL_TO` from
**the marketing static site's** environment. Keep the AI backend's existing
`RESEND_API_KEY` and `EMAIL_FROM` if it uses them for sign-in emails. Remove its
obsolete `CONTACT_EMAIL_TO` setting. Backend/chart/Pulumi updates in this change
remove the old endpoint and marketing routing while retaining transactional email.

### 5. Verify

First check CORS without sending an email (replace the example URL):

```sh
curl -i -X OPTIONS 'https://thunderbolt-contact.YOUR-SUBDOMAIN.workers.dev/api/contact' \
  -H 'Origin: https://www.thunderbolt.io' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

Expect 204 with `Access-Control-Allow-Origin: https://www.thunderbolt.io`.
Then submit one clearly labeled test inquiry through the actual website. In the
browser's Network panel the POST should go to the Worker, return 200, and contain
`{"success":true}`. Check the team inbox and Resend's email delivery status.
Acceptance by Resend is not a guarantee of inbox delivery; bounces appear in Resend.

Common failures:

| Status                   | Check                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| No Worker request        | Render needs `PUBLIC_CONTACT_ENDPOINT` and a fresh build.                                             |
| 403 / browser CORS error | Exact website origin must be in `ALLOWED_ORIGINS`.                                                    |
| 422                      | Invalid fields or a filled hidden honeypot.                                                           |
| 429                      | Wait for the response’s `Retry-After` interval (up to an hour).                                       |
| 503                      | All three Worker secrets must be present; sender and recipient must be bare valid email addresses.    |
| 502                      | Check Resend domain verification, sending-key permissions, service status, and Worker binding errors. |

A browser navigation to the Worker URL is not a form submission: `/` returns 404;
GET is not supported on the endpoint.

## Automatic deployments after setup

`.github/workflows/contact-worker.yml` tests and bundles on relevant PRs. To enable
production deployment on relevant merges to `main`, in GitHub repository Settings
→ Secrets and variables → Actions add:

- Secret `CLOUDFLARE_ACCOUNT_ID`: the account owning the Worker.
- Secret `CLOUDFLARE_API_TOKEN`: a Cloudflare token with **Account → Workers Scripts → Edit**
  scoped to that account. The workers.dev deployment does not need DNS or zone permissions.
- Repository variable `CONTACT_WORKER_ENABLED`: `true`.

The workflow also supports manual **Run workflow** on `main`. Deployment stays off
until that variable is set; PRs never deploy or receive deployment credentials.
Resend secrets stay in Cloudflare, not GitHub. Do not also enable Cloudflare's Git
build integration for this Worker: choose one deployment owner.

## Local development and tests

From this directory:

```sh
bun run test
bun run check
bun run build # local bundle validation only; does not deploy
cp .dev.vars.example .dev.vars
# Fill .dev.vars with a test sending key and an inbox you control.
bun run dev
```

In another terminal, from `web/`, run:

```sh
PUBLIC_CONTACT_ENDPOINT=http://localhost:8787/api/contact bun run dev
```

The example local origins assume Astro uses port 4321; update `.dev.vars` if it
chooses another port. Manual submissions with real credentials send real email.
The automated tests use a mock provider and never send email. Limiter tests use
real local workerd/SQLite storage to check concurrency, restart persistence, and
expiry; they need permission to open loopback ports. `.dev.vars` files
are ignored by Git. Use a separate Worker, origins, and inbox for hosted staging.

## Boundaries

- JSON-only POST, exact origin allowlist, strict field validation, honeypot, and
  a 32 KiB streamed-body cap. CORS is a browser control, not bot authentication.
- One shared Durable Object allows **3 valid submission attempts per IP per rolling
  hour and 30 total per rolling hour**, across all Cloudflare locations. Capacity is
  reserved atomically before calling Resend; failed sends also consume the budget.
  A separate approximate edge limit of 3 requests/IP/minute rejects bursts before
  reading request bodies. Neither limit is bot authentication. Shared networks
  share an IP allowance. Only Cloudflare's client-IP header is used.
- The shared cap deliberately prioritizes a bounded inbox/email bill over
  availability during abuse. Ten addresses (including rotated IPv6 addresses)
  can consume the hourly budget and cause legitimate visitors to receive 429
  responses until capacity expires, potentially for an hour. IPs are keyed as
  supplied by Cloudflare, not grouped by IPv6 subnet. If sustained abuse occurs,
  add a verified bot challenge before reserving capacity rather than just raising
  the global cap. CORS and these quotas alone cannot prevent this lockout.
- Rate-limit state contains at most 30 timestamps and SHA-256 IP hashes, not raw
  addresses or message content. Alarms remove expired records from active storage
  after an hour; Cloudflare's storage recovery/backups have their own retention.
  Hashes are pseudonymous identifiers, not a guarantee of anonymity.
- The Worker does not store submissions or log message contents, addresses, keys,
  or provider responses. Messages necessarily pass through Cloudflare, Resend,
  and the destination email provider.
- No automatic email retries. Provider failures, timeouts, and malformed
  acknowledgements never produce a success screen.

References: [Cloudflare Resend tutorial](https://developers.cloudflare.com/workers/tutorials/send-emails-with-resend/),
[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[rate-limit semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[GitHub deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
