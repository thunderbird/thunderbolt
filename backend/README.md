# Thunderbolt Backend

This is the REST API backend that powers Thunderbolt's AI inference, tool calls, and cloud features.


## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0

### Installation

```bash
# Install dependencies
bun install

# Copy environment configuration
cp env.example .env

# Edit .env with your configuration
```

### Documentation via Swagger

- API documentation is available at `/swagger` when running the server
- All routes are automatically documented with OpenAPI/Swagger
- TypeScript provides inline documentation and type checking

### Development

```bash
# Start development server with hot reload
bun run dev

# Run tests
bun test

# Run tests in watch mode
bun run test:watch

# Type checking
bun run type-check
```

### Production

```bash
# Build the application
bun run build

# Start production server
bun run start
```

### Health Checks

- `GET /flower/healthcheck/{publisher}/{model}?token=<token>` - Test Flower AI model (e.g., `/flower/healthcheck/qwen/qwen3-235b?token=...`)

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test test/main.test.ts

# Run tests with coverage
bun test --coverage
```

