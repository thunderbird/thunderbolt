# Thunderbolt Architecture

```mermaid
graph TB
  subgraph LOCAL["User Device"]
    direction LR
    TAURI["Tauri Shell<br/>Desktop · iOS · Android"]
    UI["React Frontend<br/>React 19 · Vite · Radix UI"]
    STATE["State & Data<br/>Zustand · TanStack Query · Drizzle"]
    AI["AI Chat<br/>Vercel AI SDK · MCP Client"]
    CRYPTO["E2E Encryption (optional)"]
    SQLITE[("SQLite<br/>Offline-first")]

    TAURI --- UI
    UI --- STATE
    UI --- AI
    STATE --- CRYPTO
    CRYPTO --- SQLITE
  end

  subgraph SERVER["Server Infrastructure (self-hostable)"]
    direction LR
    API["Backend API<br/>Elysia on Bun"]
    AUTH["Auth<br/>Better Auth · OTP · OIDC"]
    INFERENCE["Inference Proxy<br/>Rate Limiting · Routing"]
    PS["PowerSync<br/>Sync Engine"]
    PG[("PostgreSQL")]

    API --- AUTH
    API --- INFERENCE
    PS --- PG
    AUTH --- PG
  end

  subgraph EXTERNAL["External Services"]
    direction LR
    LLM["LLM Providers<br/>Anthropic · OpenAI · Mistral · OpenRouter"]
    OAUTH["OAuth<br/>Google · Microsoft"]
    POSTHOG["PostHog<br/>Analytics"]
    RESEND["Resend<br/>Email"]
  end

  STATE -- "sync (HTTPS)" --> PS
  STATE -- "REST / HTTPS" --> API
  AI -- "SSE streaming" --> INFERENCE
  UI -- "OAuth redirect" --> AUTH

  INFERENCE --> LLM
  AUTH --> OAUTH
  API --> POSTHOG
  API --> RESEND

  style LOCAL fill:#0f172a,stroke:#3b82f6,stroke-width:2px,color:#e2e8f0
  style SERVER fill:#0f172a,stroke:#8b5cf6,stroke-width:2px,color:#e2e8f0
  style EXTERNAL fill:#0f172a,stroke:#ec4899,stroke-width:2px,color:#e2e8f0
```

> **Boundary key:** Blue = on-device · Purple = server · Pink = third-party SaaS

## Key Architectural Properties

- **Offline-first**: Local SQLite is the source of truth. The app works without network.
- **Cross-platform**: A single React codebase runs in Tauri on desktop (macOS, Linux, Windows) and mobile (iOS, Android).
- **Model-agnostic**: LLM calls route through the backend inference proxy, supporting Claude, GPT, Mistral, and OpenRouter.
- **Self-hostable**: The entire server stack (backend, PostgreSQL, PowerSync, Keycloak) runs via Docker Compose.
- **E2E Encrypted (optional)**: When enabled, data is encrypted before leaving the device and the server stores only ciphertext. See [E2E Encryption](./e2e-encryption.md) for details.

> ⚠️ **Note:** Multi-device sync is under active development and is subject to further refinements.

> ⚠️ **Note:** End-to-end encryption is under active development, has not yet undergone a cryptography audit, and is subject to further refinements.
