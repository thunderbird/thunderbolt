# Authentication

`AUTH_MODE` picks the primary sign-in path, and the app build follows it. There is no username-and-password sign-in, and no Google or Microsoft social login. The email-code endpoints stay mounted in every mode, so an SSO deployment that does not need mail should leave `RESEND_API_KEY` unset. Personal access tokens, the command-line device grant and optional anonymous sessions sit alongside the primary path.

## Pick a method

| Method              | Setting              | You provide                                     | Use it when                                                                     |
| ------------------- | -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| OIDC single sign-on | `AUTH_MODE=oidc`     | An issuer URL, a client ID and a client secret  | Your organization already has an identity provider. Start here.                 |
| SAML single sign-on | `AUTH_MODE=saml`     | A sign-on URL, two entity IDs and a certificate | Your identity provider speaks SAML 2.0 and not OIDC.                            |
| Email sign-in code  | `AUTH_MODE=consumer` | A transactional email service                   | You have no identity provider. Read the limitations below before choosing this. |

We recommend OIDC wherever you have the choice. Both SSO modes put sign-in and access control with your identity provider; OIDC is the simpler of the two to configure.

Every deployment path (Docker Compose, Kubernetes, AWS) ships with `oidc` set and a Keycloak container preloaded with a realm and a `demo@thunderbolt.io` / `demo` user, so sign-in works on first boot. Replace that with your own provider before real users arrive.

## The mode is set in two places

| Where     | Setting                             | Values                                     |
| --------- | ----------------------------------- | ------------------------------------------ |
| Server    | `AUTH_MODE`                         | `consumer`, `oidc`, `saml`                 |
| App build | `VITE_AUTH_MODE` (a build argument) | `sso` for OIDC or SAML, unset for consumer |

An unset `AUTH_MODE` falls back to `consumer`, so set it explicitly. `VITE_AUTH_MODE` is baked into the app at build time rather than read at runtime, so switching between SSO and email sign-in means rebuilding the app image. The server refuses to start if the chosen mode's settings are incomplete.

## OIDC

### What you configure

| Variable             |  Required   | What it is                                                                                        |
| -------------------- | :---------: | ------------------------------------------------------------------------------------------------- |
| `AUTH_MODE`          |     yes     | Set to `oidc`                                                                                     |
| `OIDC_ISSUER`        |     yes     | Your provider's issuer URL, as it appears in tokens                                               |
| `OIDC_CLIENT_ID`     |     yes     | The client (application) registered with your provider                                            |
| `OIDC_CLIENT_SECRET` |     yes     | That client's secret                                                                              |
| `OIDC_DISCOVERY_URL` |     no      | Override when the server reaches the provider at a different hostname                             |
| `TRUSTED_ORIGINS`    | in practice | Comma-separated list. Has a default, but sign-in fails unless it includes your provider's origin. |

Any provider serving standard discovery at `{OIDC_ISSUER}/.well-known/openid-configuration` works: Keycloak, Okta, Auth0, Microsoft Entra ID, and others.

```sh
AUTH_MODE=oidc
OIDC_ISSUER=https://login.example.com/realms/thunderbolt
OIDC_CLIENT_ID=thunderbolt-app
OIDC_CLIENT_SECRET=<from your provider>
TRUSTED_ORIGINS=https://thunderbolt.example.com,https://login.example.com
```

### What to register with your provider

One redirect URI, built from `BETTER_AUTH_URL` (the public URL of the server itself, which is not always the same host as the app):

```
<BETTER_AUTH_URL>/v1/api/auth/sso/callback/sso
```

Request the standard `openid`, `email` and `profile` scopes. Thunderbolt identifies a user by email address.

### Two hostnames for one provider

Inside a container network the server often reaches the provider at an internal address (`http://keycloak:8080`) while browsers reach it at a public one. Tokens carry the public issuer, so set `OIDC_ISSUER` to the browser-facing URL and `OIDC_DISCOVERY_URL` to the internal one:

```sh
OIDC_ISSUER=https://login.example.com/realms/thunderbolt
OIDC_DISCOVERY_URL=http://keycloak:8080/realms/thunderbolt/.well-known/openid-configuration
```

Put **both** origins in `TRUSTED_ORIGINS`. The server validates discovery and metadata URLs against that list and refuses anything not on it.

## SAML

### What you configure

| Variable           | Required | What it is                                                                                        |
| ------------------ | :------: | ------------------------------------------------------------------------------------------------- |
| `AUTH_MODE`        |   yes    | Set to `saml`                                                                                     |
| `SAML_ENTRY_POINT` |   yes    | Your provider's sign-on URL, where users are sent to authenticate                                 |
| `SAML_ENTITY_ID`   |   yes    | Thunderbolt's own entity ID. Must match the application you register with your provider.          |
| `SAML_IDP_ISSUER`  |   yes    | Your provider's entity ID. Assertions are checked against it.                                     |
| `SAML_CERT`        |   yes    | Your provider's signing certificate                                                               |
| `TRUSTED_ORIGINS`  |    no    | Needed only if you pass a `callbackURL` on another origin; SAML has no discovery step to validate |

```sh
AUTH_MODE=saml
SAML_ENTRY_POINT=https://login.example.com/sso/saml
SAML_ENTITY_ID=thunderbolt-saml-sp
SAML_IDP_ISSUER=https://login.example.com
SAML_CERT=MIIDazCCAlOgAwIBAgI...
TRUSTED_ORIGINS=https://thunderbolt.example.com,https://login.example.com
```

`SAML_CERT` is the raw base64 body of the certificate. Strip the `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` lines, or validation fails with a certificate error.

### What to register with your provider

Point your provider at Thunderbolt's service-provider metadata, which the server publishes at:

```
<BETTER_AUTH_URL>/v1/api/auth/sso/saml2/sp/metadata?providerId=sso
```

If your provider needs the assertion consumer URL entered by hand:

```
<BETTER_AUTH_URL>/v1/api/auth/sso/saml2/sp/acs/sso
```

Assertions must be signed. Thunderbolt validates the signature against `SAML_CERT` and the issuer against `SAML_IDP_ISSUER`.

## What single sign-on looks like to the user

There is no Thunderbolt login form. Opening the app with no session sends the browser straight to your identity provider.

If a user already has a Thunderbolt account with the same email address, signing in through your provider links to that existing account rather than creating a second one.

Signing out of Thunderbolt ends the Thunderbolt session and leaves the one your identity provider holds in place, so the next visit may re-authenticate silently. That session ends at the provider.

## Replacing the bundled Keycloak

The shipped Keycloak's realm, client secret, admin password and demo user are all published in the Thunderbolt repository.

On Docker Compose, delete the `keycloak` service from the Compose file and set your own OIDC or SAML values. On Kubernetes, point the backend settings at your provider and disable the demo user with `keycloak.demoUserEnabled: false`. That change needs the Keycloak pod restarted, because the realm file is only read at startup.

The AWS stack installs that same chart only when you set `platform` to `k8s`. On the default Fargate platform Keycloak runs as an ECS task from a prebuilt image whose realm, demo user included, is baked in at build time, so there is no `demoUserEnabled` to set: point `OIDC_*` at your own provider and remove the Keycloak service instead.

> Whichever path you are on, the bundled Keycloak stores nothing outside its own container and re-imports its realm from a file on startup. Anything you configure in its admin console is lost when the container is replaced.

## Email sign-in codes

In `consumer` mode a user types an email address and receives an 8-digit code, sent both as a code to type and as a link to click. Either works.

| Behaviour            | Value                                                          |
| -------------------- | -------------------------------------------------------------- |
| Code length          | 8 digits                                                       |
| Valid for            | 10 minutes                                                     |
| Attempts per code    | 3, then the code is dead                                       |
| Resend               | Re-sends the same code, so it cannot reset the attempt counter |
| Requests per address | One every 15 seconds                                           |

Typing the code also requires a challenge token issued alongside it, so the eight digits on their own are not enough. That token is tied to the email address rather than to one browser, and the emailed link carries it, so treat the message itself as the credential.

### Two limitations to know before choosing this mode

**The sender address is not configurable.** Sign-in email is sent through [Resend](https://resend.com) using a fixed Thunderbolt sender domain, so a self-hosted deployment cannot currently send these emails under its own domain. We recommend single sign-on instead.

**Access is gated by an allowlist, and there is no admin interface for it.** Every email address must either already have an account or be approved before it can receive a code. An unapproved address gets a "you have joined the waitlist" email instead, with no code in it. Your only configuration lever is a domain allowlist:

```sh
WAITLIST_AUTO_APPROVE_DOMAINS=example.com,example.org
```

Any address at a listed domain is approved on first request. The list is read at startup, so restart the server after changing it. Approving an individual address outside those domains means editing the `waitlist` table by hand, and [Users and access](../admin/users-and-access.md#approve-one-address) has the SQL. There is no admin page, API or command for it. The gate is always active in `consumer` mode, whatever `WAITLIST_ENABLED` is set to.

In production mode a server with no email service refuses the sign-in request outright, with an "Email service not configured" error.

> Outside production mode it writes the code and the sign-in link to its own logs instead of sending them. Anyone who can read your logs can sign in as anyone.

## Desktop and mobile

On desktop, OIDC and SAML sign-in opens your system browser: you authenticate there, and the browser hands the session back to the app over a local connection on the same machine. Email sign-in happens entirely inside the app.

That browser handoff needs one of the ports `17421`, `17422` or `17423` free on the user's own machine. A listener opens on one of them only during a sign-in, and only the same machine connects to it. A local firewall blocking all three breaks desktop sign-in, with no fallback.

Which server the apps talk to is fixed when they are built. Pointing desktop or mobile users at your deployment means producing your own builds with your API and app URLs, and rebuilding when you change the authentication mode. The browser app has no such constraint.

The sign-in link in an email opens the hosted Thunderbolt app directly on iOS and Android. For a self-hosted deployment that link opens in the browser instead, which still signs the user in.

## Other ways in

Command-line sign-in is enabled by default. `thunderbolt login` shows a code, the user approves it in the app, and the CLI receives a session. Registering the CLI as a visible, revocable device requires `CLI_DEVICE_REGISTRATION_ENABLED=true`. Two settings tune the grant: `DEVICE_AUTH_EXPIRES_IN` (default `30m`) is how long an unapproved code stays valid, and `DEVICE_AUTH_INTERVAL` (default `5s`) the minimum polling gap.

Personal access tokens, the long-lived tokens users create for scripts and automation, are enabled by default too. A token is shown once at creation and lasts 90 days, or whatever `API_KEY_DEFAULT_EXPIRES_IN` (in seconds) says. Confidential models refuse a token unless `CONFIDENTIAL_API_KEYS_ENABLED=true`.

Anonymous sessions ship disabled, and an SSO-built app never offers them. The server setting is mode-independent, though: `AUTH_ALLOW_ANONYMOUS=true` mounts the anonymous sign-in endpoint whatever `AUTH_MODE` is, so leave it off on an SSO deployment. Turning them on takes `AUTH_ALLOW_ANONYMOUS=true` on the server, which lets visitors try the app with no account, plus an app built with `VITE_AUTH_ENABLE_ANONYMOUS=true` and `VITE_BYPASS_WAITLIST=true`. With the server setting alone, visitors still meet the sign-in wall; with the build flags alone, they get a button the server has no endpoint for. An anonymous session bypasses the email allowlist by design.

## Sessions and devices

A session belongs to the device that created it. With sync on, users see every signed-in device under Settings, Devices, and can revoke any of them. Without sync a device only ever sees itself, so revoking a lost one needs sync. Revoking ends that device's sessions and stops it syncing, and the revoked device is told why the next time it reaches the server.

## Troubleshooting

| Symptom                                                        | Likely cause                                                              | Fix                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The app loads normally instead of redirecting to your provider | The app was built without `VITE_AUTH_MODE=sso`, or a stale session exists | Rebuild the app image, or clear site data in the browser and reload                           |
| An untrusted-origin error during sign-in                       | Your provider's origin is missing from `TRUSTED_ORIGINS`                  | Add it. Container deployments usually need both the public and the internal origin.           |
| A discovery error during sign-in                               | The provider is unreachable from the server                               | Check the provider is running and set `OIDC_DISCOVERY_URL` to an address the server can reach |
| The server will not start, naming an OIDC or SAML variable     | A setting the chosen mode requires is missing or misspelled               | Set every variable listed for that mode above                                                 |
| The callback returns 404                                       | The redirect URI registered with the provider does not match              | Register `<BETTER_AUTH_URL>/v1/api/auth/sso/callback/sso` exactly                             |
| SAML rejects the assertion                                     | The wrong assertion consumer URL, or a mismatched entity ID               | Compare the provider's configuration against the service-provider metadata URL above          |
| An invalid certificate error on SAML                           | The certificate still has its PEM header and footer                       | Use the raw base64 body only                                                                  |
| Nobody receives a sign-in code                                 | No email service is configured, or the address is not approved            | Check the server logs. An unapproved address gets a waitlist email instead of a code.         |

## Next

- [Configuration](./configuration.md): the full settings reference, including everything on this page.
- [Docker Compose](./docker-compose.md), [Kubernetes](./kubernetes.md), [AWS with Pulumi](./pulumi.md): where to put these settings for each deployment path.
