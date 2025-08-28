---
allowed-tools: Bash(load-secrets)
arguments: [$ARGUMENTS]
argument-hint: [available secrets sets: `mcp`, `llm`]
description: load secrets into the environment. This command loads secret values from 1Password into predefined env var sets. The function will require the user to authenticate before secrets are loaded. The values will be available only to the current shell session.
---
