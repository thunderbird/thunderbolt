# Flower AI Provider

This module contains the Flower Intelligence provider for Vercel AI SDK.

## Overview

The Flower provider enables integration with Flower Intellgence's AI models, supporting:

- Streaming text generation
- Encryption for confidential models
- Remote handoff via Flower API

## Usage

```typescript
import { createFlowerProvider } from '@/flower'

const provider = createFlowerProvider({
  encrypt: true, // Enable encryption for confidential models
})

const model = provider('qwen/qwen3-235b')
```

## Testing

Run tests with:

```bash
bun test
```
