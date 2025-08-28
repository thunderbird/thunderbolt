# Thunderbolt Architecture Overview

**AI-powered email client with privacy-first design and cross-platform capabilities**

## Technology Stack

### Languages & Versions
- **TypeScript** (ES2020): Frontend with strict type checking
- **Rust** (2021): Desktop app, native modules, MCP bridge
- **Python** (>=3.12): FastAPI backend services

### Runtime & Framework Stack
- **Frontend**: React 19.1.1 + React Router 7.8.1 + Vite 7.1.3
- **Desktop**: Tauri 2.8.2 for cross-platform native apps
- **Backend**: FastAPI + uvicorn ASGI server
- **Database**: LibSQL with Drizzle ORM (local-first, encrypted)

### Package Managers
- **Frontend**: `bun` (preferred)
- **Python**: `uv` for modern dependency management
- **Rust**: `cargo` with workspace organization

## Project Structure

```
├── src/                      # React frontend application
│   ├── components/           # Radix UI-based components
│   ├── ai/                   # LLM integration & streaming
│   ├── chats/                # Chat interface & state
│   ├── db/                   # Database schema & migrations
│   ├── integrations/         # External service integrations
│   ├── imap/                 # Email client & sync
│   └── lib/                  # Core utilities & providers
├── src-tauri/                # Rust desktop application
│   ├── src/                  # Tauri application logic
│   ├── thunderbolt_*/        # Modular Rust workspaces
│   └── capabilities/         # Security definitions
├── backend/                  # Python FastAPI server
│   ├── auth/                 # Authentication providers
│   ├── pro/                  # Pro tools & integrations
│   └── tests/                # Backend test suite
└── .claude/                  # Project context & configuration
```

## Core Architecture Pattern

**Hybrid Multi-Runtime Architecture**: Combines desktop app (Tauri), web frontend (React), and API backend (FastAPI) with local-first data storage.

### Business Domain
**AI-Powered Email Assistant**: Privacy-focused desktop application providing intelligent email management, search, and automation using local AI processing.

## Key Workflows

### 1. Chat/AI Interaction Flow
```
User Input → Chat UI → AI SDK → Streaming Parser → Tool Execution → Response Display
```
- **Location**: `src/chats/chat.tsx`, `src/ai/streaming/`
- **Features**: Real-time streaming, tool calls, reasoning display

### 2. Email Processing Pipeline
```
IMAP Sync → Email Parser → Vector Embeddings → Local Database → Search Interface
```
- **Location**: `src/imap/`, `src-tauri/thunderbolt_imap_*/`
- **Features**: Incremental sync, encrypted storage, semantic search

### 3. MCP Integration Pattern
```
MCP Server → HTTP Transport → Client Provider → Tool Registry → AI Tool Calls
```
- **Location**: `src/lib/mcp-provider.tsx`, `src/lib/tauri-http-transport.ts`
- **Features**: Protocol-compliant tool execution, server management

## Key Dependencies

### Frontend Core
- **AI/ML**: Vercel AI SDK (5.0.21) for LLM interactions
- **UI**: Radix UI components + Tailwind CSS 4.1.12
- **State**: TanStack Query (5.85.5) + Zustand patterns
- **MCP**: @modelcontextprotocol/sdk (1.17.3)

### Backend Core
- **Web Framework**: FastAPI with async support
- **Database**: Drizzle ORM with libsql driver
- **ML**: Candle framework for on-device embeddings

### Infrastructure
- **Containerization**: Docker with resource limits (512MB, 1 CPU)
- **CI/CD**: GitHub Actions with multi-platform builds
- **Cloud**: CrabNebula Cloud for release management

## Technical Innovations

### Multi-Language Integration
- **Tauri Commands**: Rust functions exposed to frontend via macros
- **MCP Bridge**: Protocol-compliant tool integration
- **Proxy Architecture**: FastAPI backend proxies AI providers

### Privacy-First Design
- **Local-First**: All data stored locally with LibSQL encryption
- **On-Device AI**: Candle framework for local embeddings
- **Minimal Cloud**: Only auth and model inference require external services

### Modular Rust Architecture
- **Workspace Organization**: Separate crates (IMAP, embeddings, LibSQL)
- **Feature Gates**: Optional compilation for minimal dev builds
- **Cross-Platform**: iOS, Android, desktop from single codebase

---

**Development Commands**:
- `make setup` - Initialize project and dependencies
- `make run` - Start backend and frontend dev servers  
- `make build-desktop` - Build Tauri desktop app
- `make test` - Run full test suite