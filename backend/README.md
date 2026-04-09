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
cp .env.example .env

# Edit .env with your configuration
```

### Documentation via Swagger

- API documentation is available at `/v1/swagger` when `SWAGGER_ENABLED=true` is set
- All routes are automatically documented with OpenAPI/Swagger
- TypeScript provides inline documentation and type checking

### Development

```bash
# Start development server with hot reload
bun run dev

# Run migrations
bun run db migrate

# Run tests
bun test

# Run tests in watch mode
bun run test:watch

# Type checking
bun run type-check

# Run Postgres (serves data from .pglite/data)
bun run db:dev
```

### Database

The project uses Drizzle with PGLite for development and tests (files in .pglite/data) and Postgres in production.

PowerSync tables that hold default data (settings, models, modes, tasks, prompts) use composite primary keys `(id/key, user_id)` so each user can have their own row with the same default ID. See [composite-primary-keys-and-default-data.md](../docs/composite-primary-keys-and-default-data.md).

```bash
# Run Postgres via PGLite (serves data from .pglite/data)
bun run db:dev

# Run any drizzle-kit command
bun db <drizzle-kit command>

# Generate a new migration after changing schema.ts
bun db generate

# run migrations
bun db migrate
```

### Production

```bash
# Build the application
bun run build

# Start production server
bun run start
```

## Email Templates

Email templates are built with [React Email](https://react.email) and live in `src/emails/`. They're sent via [Resend](https://resend.com).

```bash
# Preview templates in the browser at http://localhost:3000
bun run email
```

Templates are React components that accept typed props and are passed directly to Resend's `react` option — no hosted templates or template IDs needed.

## OpenTelemetry

OpenTelemetry integration is available for distributed tracing and observability. To enable:

1. Set `OTEL_EXPORTER_OTLP_ENDPOINT` in your `.env` file
2. (Optional) Set `OTEL_EXPORTER_OTLP_TOKEN` for authenticated backends

### Supported Backends

- BetterStack
- Jaeger
- Zipkin
- New Relic
- Grafana Cloud
- Any OpenTelemetry-compatible backend

### Example: BetterStack

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-instance.betterstackdata.com/v1/traces
OTEL_EXPORTER_OTLP_TOKEN=your_betterstack_token
```

### Example: Local Jaeger

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

OpenTelemetry will automatically:

- Collect span data for all requests
- Group lifecycle hooks together
- Measure function execution time
- Instrument HTTP requests/responses
- Collect errors and exceptions

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test test/main.test.ts

# Run tests with coverage
bun test --coverage
```
