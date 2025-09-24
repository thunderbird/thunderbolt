# Thunderbolt Backend (Elysia)

A modern TypeScript backend rewritten from Python FastAPI to Elysia.js, providing exact API compatibility while leveraging TypeScript's type safety and Bun's performance.

## Features

- 🦊 **Elysia.js** - Fast, type-safe web framework
- ⚡ **Bun** - JavaScript runtime and package manager
- 🔒 **TypeScript** - Full type safety with no `any` or `unknown` types
- 🔄 **API Proxy** - Seamless proxying to external services (Fireworks, Flower AI, PostHog)
- 🔐 **OAuth** - Google and Microsoft authentication
- 🛠️ **Pro Tools** - Exa search, weather data, content fetching
- 📊 **Health Checks** - Comprehensive monitoring with Flower AI validation
- 🧪 **Testing** - Comprehensive test suite with Bun's test runner
- 📚 **OpenAPI** - Auto-generated Swagger documentation

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0

### Installation

```bash
# Clone and navigate to the directory
cd backend-elysia-sonnet

# Install dependencies
bun install

# Copy environment configuration
cp env.example .env

# Edit .env with your configuration
```

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

## Configuration

All configuration is handled through environment variables. See `env.example` for available options.

### Key Environment Variables

- `FIREWORKS_API_KEY` - Fireworks AI API key for OpenAI-compatible proxy
- `FLOWER_MGMT_KEY` - Flower AI management key
- `FLOWER_PROJ_ID` - Flower AI project ID
- `EXA_API_KEY` - Exa AI API key for search and content fetching
- `GOOGLE_CLIENT_ID/SECRET` - Google OAuth credentials
- `MICROSOFT_CLIENT_ID/SECRET` - Microsoft OAuth credentials
- `MONITORING_TOKEN` - Token for health check endpoints
- `PORT` - Server port (default: 8000)

## API Endpoints

### Core Routes

- `GET /health` - Basic health check
- `GET /locations?query=<location>` - Search for locations using OpenMeteo
- `POST /flower/api-key` - Get Flower AI API key for authenticated users
- `GET /posthog/config` - Get PostHog analytics configuration

### Authentication

- `GET /auth/google/config` - Google OAuth configuration
- `POST /auth/google/exchange` - Exchange Google authorization code
- `POST /auth/google/refresh` - Refresh Google access token
- `GET /auth/microsoft/config` - Microsoft OAuth configuration
- `POST /auth/microsoft/exchange` - Exchange Microsoft authorization code
- `POST /auth/microsoft/refresh` - Refresh Microsoft access token

### Pro Tools

- `POST /pro/search` - Neural search with Exa AI
- `POST /pro/fetch-content` - Fetch webpage content
- `POST /pro/weather/current` - Get current weather
- `POST /pro/weather/forecast` - Get weather forecast
- `POST /pro/locations/search` - Search locations for weather

### Health Checks

- `GET /flower/healthcheck/{model}?token=<token>` - Test Flower AI model

### Proxy Endpoints

- `/openai/*` - Proxy to Fireworks AI (OpenAI-compatible)
- `/flower/*` - Proxy to Flower AI
- `/posthog/*` - Proxy to PostHog analytics  
- `/proxy/*` - Generic proxy endpoint

## Architecture

The application is structured around Elysia's plugin system:

```
src/
├── auth/           # Authentication (OAuth, Flower API keys)
├── config/         # Configuration and settings
├── pro/           # Pro tools (Exa, weather)
├── routes/        # Main API routes (including flower proxy & health)
├── utils/         # Utility functions
└── index.ts       # Application entry point
```

## API Compatibility

This backend maintains 100% API compatibility with the original Python FastAPI version. You can point your frontend to this backend without any changes.

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test test/main.test.ts

# Run tests with coverage
bun test --coverage
```

## Development

The codebase follows these principles:

- **Type Safety** - No `any` or `unknown` types
- **Simplicity** - Prefer concise, readable code
- **Early Returns** - Avoid nested conditionals
- **Const over Let** - Immutable by default
- **JSDoc** - Document utility functions
- **Error Handling** - Optimistic with proper error boundaries

## Documentation

- API documentation is available at `/swagger` when running the server
- All routes are automatically documented with OpenAPI/Swagger
- TypeScript provides inline documentation and type checking

## License

Mozilla Public License 2.0
