# Provider connections

A provider is a service with optional capabilities. A connection is a named authorization to that service. Models and web search use connections; neither owns a copy of its credentials.

`src/providers/registry.ts` declares the available provider types and their supported model/search capabilities. `fetchProviderModels` and `addProviderModels` expose the model capability; `getSearchConnectionApi` exposes search/fetch through the existing provider-specific transports. Tinfoil retains its confidential transport. Otari uses its direct tools API. Compute implementations are deliberately not part of this change.

## Data and authentication

`provider_connections` syncs metadata: provider type, name, endpoint, authentication method, enabled state, timestamps and soft deletion. Names, endpoints and `models.provider_connection_id` use the existing encrypted sync columns. `provider_connection_secrets` is device-local and keyed by connection ID. Its credential binding covers provider, authentication method and endpoint; a synced routing change cannot reuse an existing device key.

OAuth uses a stable `oauth:<provider>` identity: one sign-in per service, regardless of endpoint. Named API-key connections have independent IDs. A synced connection with no matching local credential requires signing in on that device. Disabling a connection does not modify model toggles. Disconnecting clears only local authorization and retains metadata and model/history references.

The DAL provides one connection API for metadata, device credentials and request-time resolution. The integration credential DAL remains a compatibility boundary for the existing OAuth session lifecycle and pre-migration rows. Google and Microsoft retain their separate account/integration flow.

An opaque fingerprint detects asynchronous authorization or verification superseded by a disconnect, configuration change or replacement sign-in. Credential generations stay stable through normal token refresh; refresh writes compare the original snapshot and binding before storing rotated tokens. Inference and search requests resolve authorization again and reject a changed connection. Catalog additions compare the captured monotonic `updatedAt` value inside their transaction, so an old catalog cannot silently add models to a replacement account.

## User flows

Connections creates and manages authorizations without requiring a model. Multiple models can be selected from a searchable catalog; custom endpoints also accept a manually entered model ID. Model settings retain model-specific preferences and link to the exact named connection for credentials.

Onboarding connects a provider and chooses an initial/default model. Otari/Tinfoil search can finish search setup when available; an unconfigured Otari search service explains the missing configuration and leaves the search step visible. Changing connections in Settings preserves an explicit search choice.

Search onboarding uses one choice per provider, reusing an available connection after authorization rather than adding a duplicate choice. Exa and Tavily offer OAuth or an API key; Brave uses an API key. Browser and native OAuth returns resume the originating wizard or aside.

## Migration, backup and rollout

Runtime migrations preserve model IDs, profiles, enabled settings and history. See [standalone mode](standalone-mode.md) for the cross-device legacy credential migration and search-selection behavior. Legacy tables remain readable while older devices and backups can still supply their rows; new authoring flows write connection-owned credentials.

Exports include connection metadata and user-entered API keys with their bindings. OAuth access and refresh tokens are excluded and are never restored from an import. See [export format](export-format.md).

The backend preparation must ship first: schema migration, shared table registry and all three PowerSync configurations. Deploy that PowerSync image before merging the frontend registration. The frontend remains runnable locally in standalone mode while that deployment is pending. See [synced table rollout](powersync-account-devices.md#pr-flow-for-adding-tables).
