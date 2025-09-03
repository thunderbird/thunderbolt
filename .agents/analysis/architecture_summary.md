# Thunderbolt Codebase Architecture Analysis

## 1. Technology Stack Analysis

### Primary Programming Languages and Versions
- **TypeScript** (ES2020): Primary frontend language with strict type checking
- **Rust** (Edition 2021): Backend systems, desktop app, and native modules
- **Python** (>=3.12): API backend server with FastAPI framework

### Framework and Runtime Stack
- **Frontend**: React 19.1.1 with React Router 7.8.1 for SPA routing
- **Desktop Runtime**: Tauri 2.8.2 for cross-platform desktop application
- **Backend API**: FastAPI (Python) with uvicorn ASGI server
- **Build Tools**: Vite 7.1.3 as primary frontend bundler
- **Package Management**: Bun for frontend, uv for Python, Cargo for Rust

### Key Dependencies and Their Purposes
- **AI/ML Integration**: Vercel AI SDK (5.0.21) for LLM interactions, streaming responses
- **Database**: Drizzle ORM (0.44.4) with libsql for encrypted local storage
- **UI Framework**: Radix UI components with Tailwind CSS 4.1.12 for styling
- **State Management**: TanStack Query (5.85.5) for server state, Zustand patterns
- **Model Context Protocol**: @modelcontextprotocol/sdk (1.17.3) for MCP integration
- **Email Processing**: Rust-based IMAP client and mail parsing
- **Embeddings**: Candle ML framework for on-device vector generation

## 2. Project Structure Analysis

### Main Source Directories
```
/src/                    # Frontend React application
├── components/          # Reusable UI components (Radix-based)
├── ai/                 # LLM integration and streaming
├── chats/              # Chat interface and state management
├── db/                 # Database schema, migrations, DAL
├── integrations/       # External service integrations (Google, Microsoft)
├── flower/             # Flower AI framework integration
├── imap/               # Email client and sync
├── lib/                # Core utilities and providers
└── settings/           # Application configuration UI

/src-tauri/             # Rust desktop application
├── src/                # Main Tauri application logic
├── thunderbolt_*/      # Modular Rust workspaces
└── capabilities/       # Security capability definitions

/backend/               # Python FastAPI server
├── auth/               # Authentication providers
├── pro/                # Pro tools and integrations
└── tests/              # Backend test suite
```

### Configuration Management
- **Frontend Config**: `/vite.config.ts`, `/tsconfig.json`, `/components.json` (shadcn)
- **Database**: `/drizzle.config.ts` for schema management
- **Rust Config**: `/src-tauri/Cargo.toml` with workspace organization
- **Python Config**: `/backend/pyproject.toml` with uv dependency management
- **Development**: `/Makefile` for unified development commands

### Asset Organization
- **Icons**: `/src-tauri/icons/` - Multi-platform app icons
- **Public Assets**: `/public/` - Web-accessible resources
- **Documentation**: `/docs/screenshots/` - Application screenshots
- **Extensions**: `/thunderbird-mcp-*` - Browser extension bridges

## 3. Architecture Identification

### Overall Architecture Pattern
**Hybrid Multi-Runtime Architecture**: Combines desktop app (Tauri), web frontend (React), and API backend (FastAPI) in a cohesive system.

### Core Business Domain
**AI-Powered Email Assistant**: Privacy-focused desktop application that provides intelligent email management, search, and automation using local AI processing and encrypted data storage.

### Main Entry Points
1. **Desktop App**: `/src-tauri/src/main.rs` → Tauri application bootstrap
2. **Frontend**: `/src/index.tsx` → React application initialization  
3. **Backend API**: `/backend/main.py` → FastAPI server with proxy capabilities
4. **Database**: `/src/db/migrate.ts` → Database initialization and migration

### Core Workflows

#### Chat/AI Interaction Flow
```
User Input → Chat UI → AI SDK → Streaming Parser → Tool Execution → Response Display
```
- Location: `/src/chats/chat.tsx`, `/src/ai/streaming/`
- Features: Real-time streaming, tool calls, reasoning display

#### Email Processing Pipeline  
```
IMAP Sync → Email Parser → Vector Embeddings → Local Database → Search Interface
```
- Location: `/src/imap/`, `/src-tauri/thunderbolt_imap_*/`
- Features: Incremental sync, encrypted storage, semantic search

#### MCP Integration Pattern
```
MCP Server → HTTP Transport → Client Provider → Tool Registry → AI Tool Calls
```
- Location: `/src/lib/mcp-provider.tsx`, `/src/lib/tauri-http-transport.ts`
- Features: Protocol-compliant tool execution, server management

## 4. Infrastructure and Deployment

### Containerization
- **Backend Docker**: `/backend/Dockerfile` and `/backend/Dockerfile.prod`
- **Docker Compose**: `/backend/docker-compose.yml` for local development
- **Resource Limits**: 512MB memory, 1 CPU core for backend container

### CI/CD Configuration
- **Release Pipeline**: `/.github/workflows/release.yml` - Tauri v2 release process
- **iOS Deployment**: `/.github/workflows/ios-deployment.yml` - Mobile app builds  
- **Multi-platform Builds**: Automated desktop builds for Windows, macOS, Linux
- **CrabNebula Cloud**: Integrated release management and distribution

### Environment Management
- **Development**: `/mise.local.toml` - Tool version management
- **Environment Variables**: Backend supports CORS, API keys, logging configuration
- **Security**: CSP policies in Tauri config, encrypted local database

### Cloud Integration Points
- **Flower AI**: Proxy endpoints for AI model inference
- **PostHog Analytics**: Privacy-compliant usage tracking
- **OAuth Providers**: Google and Microsoft authentication flows
- **External APIs**: Weather (Open-Meteo), search engines via MCP

## 5. Development Tooling

### Testing Frameworks
- **Frontend**: Vitest 3.2.4 with browser testing via Playwright
- **Backend**: pytest 8.4.0 with async support and coverage reporting
- **Component Testing**: Storybook 9.1.3 with automated visual regression testing
- **Integration**: MSW (Mock Service Worker) for API mocking

### Code Quality Tools
- **TypeScript**: Strict type checking with ES2020 target
- **ESLint**: React, TypeScript, and Storybook plugin integration
- **Prettier**: Consistent code formatting across the codebase  
- **Ruff**: Python linting and formatting with pre-commit hooks
- **Rust**: Clippy linting with workspace-level cargo configurations

### Development Automation
- **Build Scripts**: Unified `make` commands for setup, build, test, and deployment
- **Migration Management**: Automatic database migration bundling in Vite
- **Feature Flags**: Rust cargo features for optional functionality (libsql, email, embeddings)
- **Hot Reload**: Vite HMR for frontend, uvicorn reload for backend

## Key Technical Innovations

### Multi-Language Integration
- **Tauri Commands**: Rust functions exposed to frontend via procedural macros
- **MCP Bridge**: Protocol-compliant integration with external tools and services  
- **Proxy Architecture**: FastAPI backend proxies multiple AI providers with request transformation

### Privacy-First Design
- **Local-First**: All data stored locally with LibSQL encryption
- **On-Device AI**: Candle framework for local embeddings generation
- **Minimal Cloud**: Only authentication and model inference require external services

### Modular Rust Architecture
- **Workspace Organization**: Separate crates for IMAP, embeddings, LibSQL, and bridge functionality
- **Feature-Gated Compilation**: Optional features keep binary size minimal during development
- **Cross-Platform Targeting**: iOS, Android, and desktop support from single codebase

This architecture demonstrates a sophisticated approach to building a privacy-focused, AI-powered desktop application that balances local processing capabilities with cloud-based AI services while maintaining strong security and user privacy principles.