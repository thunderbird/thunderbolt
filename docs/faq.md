# Frequently Asked Questions

### How is Thunderbolt funded?

Thunderbolt is funded through a grant from Mozilla.

### What is Thunderbolt's relationship to Thunderbird?

Thunderbolt is a separate product developed under the same entity, MZLA Technologies. It is not part of Thunderbird's existing products.

### Is there going to be a hosted version if I don't want to deploy it myself?

Yes, we are planning to launch Thunderbolt for regular users but we do not have a release date yet.

### Where does my data live?

On the device you are using. Every client keeps a local SQLite database and reads and writes it first, so no edit waits on a round trip (`src/db/powersync/database.ts`). Cross-device sync is off until you turn it on: `syncEnabled` defaults to `false` (`src/stores/local-settings-store.ts:57`) and is switched on when you sign in, or from _Settings → Preferences_. See [Multi-Device Sync](./architecture/multi-device-sync.md) for what replication looks like once it is on, and [Delete Account and Revoke Device Access](./architecture/delete-account-and-revoke-device.md) for how to get the data back off a device or out of the backend.

### Can the server read my chats?

That depends on how the backend is configured, and on whether a request reaches it at all.

Synced rows are stored in the backend's PostgreSQL. End-to-end encryption is opt-in and disabled by default; with `E2EE_ENABLED=true` the columns listed in `encryptedColumnsMap` (`src/db/encryption/config.ts:30`) — chat titles, message content, task items, saved prompts, project instructions, and more — are encrypted on the client before upload and decrypted after download, so for those columns the server holds only ciphertext and wrapped keys. Everything else syncs in plaintext. [End-to-End Encryption](./architecture/e2e-encryption.md) lists the current coverage and explains the key hierarchy.

Prompts in flight are a separate question from rows at rest. In a browser, cross-origin restrictions force provider calls through the backend's `/v1/proxy`, which forwards them upstream. The desktop and mobile builds call the provider directly unless you turn the proxy on (`src/lib/proxy-fetch.ts:41`).

### Does it work offline?

Local-first writes mean new chats, messages, and edits land in SQLite immediately; on reconnect the sync worker replays the queued operations and conflicts resolve last-writer-wins at the row level. Two caveats remain while we work toward being fully offline-first: the app currently depends on authentication, and on search — which you can switch off under _Settings → Connections_. Inference needs a network unless you point Thunderbolt at a model running on your own machine.

### Does it cost money to run?

Thunderbolt is open source under the Mozilla Public License 2.0. Inference is the part that costs, and there are three ways to cover it:

- **Your own provider key.** Add a model under _Settings → Models_ with a key for Anthropic, OpenAI or OpenRouter, or point the _Custom_ provider at any OpenAI-compatible endpoint (`src/settings/models/use-add-model-form.ts:34`). Keys live in a local-only table that is never synced (`models_secrets`, `src/db/tables.ts:143-147`).
- **A local model.** Point Thunderbolt at [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp) and inference costs nothing.
- **System-managed models.** The backend serves some models on your behalf: Opus 5, routed to Anthropic, and a catalog of confidential models hosted in Tinfoil enclaves — one of which, `GLM 5.3 Flash`, is the default model on a new install (`shared/defaults/models.ts:105`, `:125`). A backend you host yourself serves those only if you give it `ANTHROPIC_API_KEY` and `TINFOIL_API_KEY`, and the usage bills to your own provider accounts. Managed inference is capped by rolling five-hour and seven-day spend quotas, tighter for anonymous users than signed-in ones and tunable via `INFERENCE_QUOTA_*` (`backend/src/config/settings.ts:147-150`).

### Which platforms can I run it on?

The web app, desktop builds for macOS (Apple silicon and Intel), Windows (x64 and ARM64) and Linux x64 (`.github/workflows/desktop-release.yml`), and iOS and Android builds (`.github/workflows/ios-release.yml`, `.github/workflows/android-release.yml`). The desktop and mobile apps are Tauri shells around the same web build, which is why the storage and sync answers above apply everywhere.

### Do you collect analytics?

Only if you opt in. The `data_collection` setting defaults to `false` (`src/defaults/settings.ts:31`) and is toggled under _Settings → Preferences_. When it is on, events go to PostHog and never carry prompts, responses, or API keys. [TELEMETRY.md](../TELEMETRY.md) documents every event and property.

### I have a bug / suggestion / feature request - how can I contribute?

Please [submit an issue](https://github.com/thunderbird/thunderbolt/issues) or open a pull request.
