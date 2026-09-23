# Frequently Asked Questions

### How is Thunderbolt funded?

Through a grant from Mozilla.

### What is Thunderbolt's relationship to Thunderbird?

A separate product under the same entity, MZLA Technologies. It is not part of Thunderbird's existing products.

### Is there going to be a hosted version if I don't want to deploy it myself?

Yes, but there is no release date yet.

### Where does my data live?

On the device you are using. Each client reads and writes a local SQLite database first (`src/db/powersync/database.ts`). Cross-device sync is off until you turn it on: `syncEnabled` defaults to `false` (`src/stores/local-settings-store.ts:57`), switched on at sign-in or from _Settings → Preferences_.

See [Multi-Device Sync](./architecture/multi-device-sync.md) for replication, and [Delete Account and Revoke Device Access](./architecture/delete-account-and-revoke-device.md) for removing data from a device or the backend.

### Can the server read my chats?

Synced rows live in the backend's PostgreSQL. End-to-end encryption is opt-in and disabled by default. With `E2EE_ENABLED=true`, the columns in `encryptedColumnsMap` (`src/db/encryption/config.ts:30`) (chat titles, message content, task items, saved prompts, project instructions and more) are encrypted client-side before upload and decrypted after download, so the server holds only ciphertext and wrapped keys. Everything else syncs in plaintext. See [End-to-End Encryption](./architecture/e2e-encryption.md) for coverage and the key hierarchy.

Prompts in flight are separate from rows at rest. Cross-origin restrictions force browser provider calls through the backend's `/v1/proxy`, which forwards them upstream; desktop and mobile call the provider directly unless you enable the proxy (`src/lib/proxy-fetch.ts:41`).

### Does it work offline?

Writes land in SQLite immediately; on reconnect the sync worker replays them, last-writer-wins per row. Two caveats: the app still requires authentication, and search (switch it off under _Settings → Connections_). Inference needs a network unless the model runs on your own machine.

### Does it cost money to run?

Thunderbolt is open source under the Mozilla Public License 2.0. Inference is the part that costs:

- **Your own provider key.** Add a model under _Settings → Models_ with an Anthropic, OpenAI or OpenRouter key, or point the _Custom_ provider at any OpenAI-compatible endpoint (`src/settings/models/use-add-model-form.ts:34`). Keys live in a local-only table that is never synced (`models_secrets`, `src/db/tables.ts:143-147`).
- **A local model.** [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp) cost nothing to run.
- **System-managed models.** The backend serves Opus 5 (routed to Anthropic) plus confidential models hosted in Tinfoil enclaves; `GLM 5.3 Flash` is the default on a new install (`shared/defaults/models.ts:105`, `:125`). A self-hosted backend serves them only with `ANTHROPIC_API_KEY` and `TINFOIL_API_KEY` set, and usage bills your own provider accounts. Rolling five-hour and seven-day spend quotas apply, tighter for anonymous than signed-in users, tunable via `INFERENCE_QUOTA_*` (`backend/src/config/settings.ts:147-150`).

### Which platforms can I run it on?

The web app, plus Tauri shells around that same build (so the storage and sync answers above apply everywhere):

- **Desktop**: macOS (Apple silicon, Intel), Windows (x64, ARM64), Linux x64 (`.github/workflows/desktop-release.yml`).
- **Mobile**: iOS, Android (`.github/workflows/ios-release.yml`, `.github/workflows/android-release.yml`).

### Do you collect analytics?

Only if you opt in. `data_collection` defaults to `false` (`src/defaults/settings.ts:31`) and is toggled under _Settings → Preferences_. When on, events go to PostHog and never carry prompts, responses, or API keys. [TELEMETRY.md](../TELEMETRY.md) documents every event and property.

### I have a bug / suggestion / feature request - how can I contribute?

Please [submit an issue](https://github.com/thunderbird/thunderbolt/issues) or open a pull request.
