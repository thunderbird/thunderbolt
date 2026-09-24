# Frequently Asked Questions

## The product

### What is Thunderbolt?

An open-source AI client you deploy yourself. It runs on the web, macOS, Windows, Linux, iOS, and Android, and connects to whichever models you choose. Each device keeps its data in a local database.

### Who makes it, and how is it funded?

We are MZLA Technologies, the entity behind Thunderbird, funded through a dedicated investment from Mozilla.

### Is it part of Thunderbird?

No. It is its own product from MZLA, the same entity that makes the Thunderbird email client.

### Is there a hosted version?

A hosted version is planned. There is no release date.

## Cost and licensing

### What does Thunderbolt cost?

The software is free. It is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/), which permits commercial and internal use. Your costs are the infrastructure you run it on and the AI inference you use.

### What does inference cost?

| Path                  | Who pays                            | Notes                                                          |
| --------------------- | ----------------------------------- | -------------------------------------------------------------- |
| Your own provider key | You, at your provider's rates       | Key stays on the device, never synced to the server            |
| A local model         | Nothing beyond your own hardware    | Run through Ollama or llama.cpp on your own machine or network |
| System-managed models | Your deployment's provider accounts | Only if you supply the backend with provider keys              |

### Is there a paid tier or a per-seat license?

No. There is no subscription, no seat count, and no license key. The project is community-supported today; deployment questions go to the [issue tracker](https://github.com/thunderbird/thunderbolt/issues).

### Do I have to publish changes I make?

MPL 2.0 is file-level copyleft. Modifications to Thunderbolt's own files must be shared under the same license if you distribute them; your separate files are unaffected. Running a modified version internally is not distribution.

## Data

### Where does my data live?

On the device. Every client reads and writes a local database first, so the app works against local data even when the network does not.

Cross-device sync is off by default and signing in turns it on for that device. An anonymous session never syncs. The toggle is under _Settings → Preferences → Data_. When it is on, synced rows are stored in your deployment's PostgreSQL database. Encryption applies to what is sent and stored on the server; the copy on the device stays readable locally so the app can search and render it.

### Can the server read my chats?

By default, yes. Synced rows land in your PostgreSQL in plaintext, readable by anyone with database access.

Turn on end-to-end encryption (E2EE) in the backend configuration and the server holds only ciphertext for the fields listed below, because the keys that would unscramble it exist on the user's devices and nowhere on your infrastructure. E2EE applies to the whole deployment, so a user cannot turn it on for one account, and it changes how new devices join: they must be approved from an already trusted device or with the recovery phrase.

```ini
E2EE_ENABLED=true
```

| Encrypted with E2EE on                        | Never encrypted                                  |
| --------------------------------------------- | ------------------------------------------------ |
| Chat titles and message content               | Record ids, timestamps, ordering, deletion flags |
| Tasks, saved prompts, skills                  | Project icons and pin order                      |
| Project names, descriptions, and instructions | Custom agent names, URLs, and descriptions       |
| Model names, endpoints, and tuning profiles   |                                                  |
| Setting values and device names               |                                                  |

End-to-end encryption is in preview. It has not yet had a cryptography audit.

### Does my data leave my network?

Sync and authentication stay inside your deployment, and prompts go wherever your chosen model lives. Web search reaches an external search provider, and only when the deployment sets `EXA_API_KEY` and the user leaves the **Thunderbolt** connection switched on.

| Model you picked                    | Where the prompt goes                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Local (Ollama, llama.cpp)           | Your machine or your network                                                                     |
| A model on your own infrastructure  | Your network                                                                                     |
| A cloud provider with your key      | That provider                                                                                    |
| A system-managed confidential model | A hardware-isolated enclave outside your network, which neither the vendor nor you can read into |

Provider calls do not go straight from the app. They are relayed through your own backend, which forwards the bytes and hands back the response. Browsers cannot call most provider APIs directly, and the published desktop and mobile builds take the same path. The user's key passes through untouched and is never stored, and your access logs record the destination hostname but not the request path.

### Are file attachments stored on the server?

No. The file contents are held on the device and travel only inside the request that answers that turn. Nothing is written to your server or your database, so an attachment is not available on the user's other devices and is not included in a data export.

One exception: if you connect an external coding agent that stages files on its own service, that agent receives the file under its own retention rules, not Thunderbolt's.

### Do you collect analytics?

Client events, only if a user opts in: the toggle sits under _Settings → Preferences_, off by default. A deployment that sets `POSTHOG_API_KEY` also emits two server-side events per inference call, attributed to the user id and independent of that toggle. No event carries prompts, responses, or API keys, and every one is listed in [Telemetry](../TELEMETRY.md). Leave `POSTHOG_API_KEY` unset to send nothing at all.

## Models

### Which models can I use?

Anything OpenAI-compatible, plus native support for Anthropic. In _Settings → Models_ you can add:

| Provider                               | Needs a key                       |
| -------------------------------------- | --------------------------------- |
| Anthropic                              | Yes                               |
| OpenAI                                 | Yes                               |
| OpenRouter                             | Yes                               |
| Tinfoil                                | Yes                               |
| Custom, any OpenAI-compatible endpoint | Only if the endpoint requires one |

The custom option is how you reach a local Ollama or llama.cpp server, or a model hosted on your own infrastructure.

Tinfoil is a confidential inference provider. Confidential means the model runs inside a hardware-isolated enclave: the request is encrypted end to end and the operator of the machine, Tinfoil included, cannot read it. The app verifies the enclave before sending anything.

### Which models does a fresh install ship with?

Three system-managed models: GLM 5.3 Flash (the default on a new install), GLM 5.3, and Opus 5. The first two run in confidential enclaves; Opus 5 is routed to Anthropic.

A backend you host serves these only if you give it the matching keys.

```ini
ANTHROPIC_API_KEY=...
TINFOIL_API_KEY=...
```

Without them, the three entries still appear in the model list but every request to them fails. Add your own provider key or a local model instead.

### Are there usage limits on system-managed models?

Yes. Two rolling spend windows apply per user, with these defaults.

| Window  | Anonymous session | Signed-in account |
| ------- | ----------------- | ----------------- |
| 5 hours | 10 cents ($0.10)  | 1500 cents ($15)  |
| 7 days  | 60 cents ($0.60)  | 7500 cents ($75)  |

Override them with `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS`, `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS`, `INFERENCE_QUOTA_REGISTERED_5H_CENTS`, and `INFERENCE_QUOTA_REGISTERED_7D_CENTS`. Usage against your own provider key is not metered or capped by Thunderbolt.

### Are user API keys visible to the server?

Not stored, no. A provider key, an agent credential, or a connected account's token is written to a part of the device's storage that is excluded from sync, so no central copy exists and a user who signs in on a second device has to enter it again there. The key does pass through your server on each request, because the browser cannot call most provider APIs directly: it is forwarded and discarded, never written down, and access logs record only the destination hostname.

## Running it

### Where can I deploy it?

| Target                                             | Best for                                |
| -------------------------------------------------- | --------------------------------------- |
| [Docker Compose](./self-hosting/docker-compose.md) | Demos, evaluations, a single host       |
| [Kubernetes](./self-hosting/kubernetes.md)         | Production, existing clusters           |
| [Pulumi on AWS](./self-hosting/pulumi.md)          | Green-field AWS, infrastructure as code |

We recommend starting with Docker Compose whatever you plan to run in the end. All three read the same settings.

All three deploy the application frontend, the backend API, a PostgreSQL server (holding two databases), the sync service that replicates data between devices, and Keycloak for single sign-on over OIDC or SAML. Kubernetes and AWS add a sixth piece, the marketing and docs site. There is no external service the deployment has to call home to.

### Does it work offline?

Partly. Changes are written to the device immediately and uploaded when the connection returns. If the same record was changed on two devices while one was offline, the most recent change wins.

Sign-in, web search, and inference against any model that is not running on your own hardware still need the network.

### Can I run it air-gapped?

Every server component runs inside your network, and with a local model and no web search there is no required outbound call at runtime. Two things to plan for:

- Official desktop builds check a hosted update service for new versions. Build your own or distribute installers internally if that is unacceptable.
- Web search needs a search provider key on the backend (`EXA_API_KEY`). Leave it unset and no search call is possible. A user can also switch the **Thunderbolt** connection off under _Settings → Connections_.
- Location search, the weather widget and map tiles call `geocoding-api.open-meteo.com`, `api.open-meteo.com` and `basemaps.cartocdn.com`. No setting disables them; block them at the network edge and those features degrade.

We don't test air-gapped operation today, so treat it as a pilot.

### How many devices can one account use?

Ten active devices. Devices awaiting approval do not count against the limit.

### What happens if a device is lost or stolen?

Revoke it from _Settings → Devices_ on another device. The revoked device loses its sessions immediately and can no longer sync. With end-to-end encryption on, the copy of the account key that was held for that device is deleted on the server, so it can never rejoin sync or be re-approved.

Revocation is not a remote wipe. The next time the revoked device runs, it shows a message the user cannot dismiss, offering to keep or delete its local copy of the data. Whatever was already on that device stays readable until its holder chooses to delete it, or until you wipe the device through whatever endpoint management you already use.

### What if all devices are lost?

With end-to-end encryption off, signing in on a new device pulls the synced data back from your database.

With it on, the 24-word recovery phrase shown once at setup is the only way back. Without that phrase, the encrypted data cannot be recovered by the user, by you, or by anyone with access to the server. We recommend making it part of your onboarding.

### What happens when a user deletes their account?

Deletion is permanent. The account and everything synced under it are removed from your database outright, and there is no undo inside the app. Every other device the user was signed in on notices within moments, erases its local copy, and signs out. Anything sitting in your own database backups is yours to manage under your own retention policy.

## Platforms

| Platform                                                            | How you get it today                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Web                                                                 | You host it                                                                                   |
| macOS (Apple silicon and Intel), Windows (x64 and ARM64), Linux x64 | Installers attached to [GitHub releases](https://github.com/thunderbird/thunderbolt/releases) |
| iOS                                                                 | TestFlight                                                                                    |
| Android                                                             | Play Store internal track                                                                     |

Mobile builds are not publicly listed in the app stores yet. Every platform runs the same application, so the storage, sync, and encryption answers above apply everywhere.

## Comparison

### How does this differ from a hosted assistant?

|                                | Thunderbolt                                      | Typical hosted assistant |
| ------------------------------ | ------------------------------------------------ | ------------------------ |
| Where conversations are stored | Your device, and your database if sync is on     | The vendor's servers     |
| Who chooses the model          | You, per chat, across providers and local models | The vendor               |
| Server access to content       | None for covered fields with E2EE on             | Full                     |
| Where it runs                  | Your infrastructure, including on-prem           | The vendor's cloud       |
| Cost model                     | Software free, you pay for inference             | Per seat, per month      |

## Getting help

Found a bug, or want a feature? [Open an issue](https://github.com/thunderbird/thunderbolt/issues).

Found a security vulnerability? Use the [private reporting form](https://github.com/thunderbird/thunderbolt/security/advisories/new) rather than a public issue.

For more depth on the topics above:

- [Security and privacy](./admin/security-and-privacy.md): what is stored, where, and who can see it
- [Users and access](./admin/users-and-access.md): sign-in, identity providers, and user access
- [Devices](./admin/devices.md): device approval, limits, and revocation
- [Configuration](./self-hosting/configuration.md): every setting and environment variable
