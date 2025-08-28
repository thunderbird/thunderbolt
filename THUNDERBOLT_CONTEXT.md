# Thunderbolt Project Context

## Project Overview

Thunderbolt is a desktop/mobile AI assistant application formerly known as Mozilla Assistant. It's built with a hybrid architecture combining Tauri (Rust) for the backend/native layer and React with TypeScript for the frontend.

### Core Mission
- AI-powered email management and automation
- On-device processing capabilities
- Cross-platform desktop and mobile support
- Privacy-first approach with local data storage

## Architecture Overview

### Technology Stack

**Frontend:**
- **React 19** - UI framework
- **TypeScript** - Primary language
- **Tailwind CSS** - Styling framework
- **Shadcn/ui** - UI component library
- **React Router v7** - Navigation and routing
- **Vercel AI SDK** - LLM interactions and streaming
- **Vite** - Build tool and development server

**Backend/Native:**
- **Rust** - Systems programming language
- **Tauri v2** - Desktop/mobile framework
- **libsql** - Local encrypted database
- **Drizzle ORM** - Database ORM and migrations
- **FastAPI (Python)** - API proxy service
- **Candle + Mistral** - On-device ML inference

**Database:**
- **libsql** - Primary local database (SQLite-compatible with encryption)
- **Drizzle** - ORM and migration management
- **Vector embeddings** - Custom F32_BLOB type for semantic search

**AI/ML:**
- **Vercel AI SDK** - LLM integration and streaming
- **Multiple providers** - OpenAI, Fireworks, Flower AI
- **On-device embeddings** - Candle with Hugging Face models
- **MCP (Model Context Protocol)** - Tool/extension system

## Project Structure

```
thunderbolt/
├── src/                          # Frontend React application
│   ├── components/              # Reusable UI components
│   │   ├── ui/                 # Shadcn/ui base components
│   │   └── chat/               # Chat-specific components
│   ├── db/                     # Database schema and operations
│   ├── lib/                    # Utility functions and services
│   ├── hooks/                  # React custom hooks
│   ├── integrations/           # External service integrations
│   ├── ai/                     # AI/LLM related functionality
│   ├── settings/               # Settings pages and management
│   └── types.ts                # Global TypeScript types
├── src-tauri/                   # Rust backend
│   ├── src/                    # Main Rust application
│   ├── thunderbolt_*/          # Feature-specific Rust crates
│   └── tauri.conf.json         # Tauri configuration
├── backend/                     # Python FastAPI proxy service
└── thunderbird-mcp-*/          # Thunderbird extension bridges
```

## Development Guidelines & Patterns

### Code Style & Conventions

**General Principles:**
- **Tasteful simplicity over defensiveness** - Clean, readable code over over-optimization
- **Optimistic programming** - Handle errors at appropriate levels, not defensively everywhere
- **Early returns** - Prefer early returns over nested conditionals
- **Functional patterns** - Prefer `const` over `let`, create helper functions instead of mutation

**TypeScript/React:**
- Use **arrow functions** over `function` declarations
- Prefer **`type`** over `interface`
- Use **`ky`** over native `fetch`
- Import hooks directly: `useEffect` not `React.useEffect`
- **One component per file** (loosely enforced)
- **JSDoc comments** required for new utility functions
- **No blank lines with whitespace** unless required by format

**Package Management:**
- Use **`bun`** over `npm`
- Lock dependencies with `bun.lock`

### Architecture Patterns

#### Database Layer (Drizzle + libsql)
```typescript
// Schema definition pattern
export const tableName = sqliteTable('table_name', {
  id: text('id').primaryKey().notNull().unique(),
  field: text('field').notNull(),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
})

// Type inference from schema
export type TableType = InferSelectModel<typeof tableName>
```

#### Component Structure
```typescript
// Preferred component pattern
export const ComponentName = ({ prop }: { prop: string }) => {
  // Early returns for loading/error states
  if (!prop) return null
  
  return (
    <div className="tailwind-classes">
      {/* Component content */}
    </div>
  )
}
```

#### Tool/Integration Pattern
```typescript
// Tool configuration structure
export const toolConfig: ToolConfig = {
  name: 'tool_name',
  description: 'Tool description',
  verb: 'action_verb',
  parameters: z.object({
    param: z.string().describe('Parameter description')
  }),
  execute: async (params) => {
    // Tool implementation
    return result
  }
}
```

#### State Management
- **React Context** for global state
- **Tanstack Query** for server state
- **Local state** with `useState` for component-specific data
- **Custom hooks** for reusable state logic

## Key System Components

### Database Architecture
- **Tables:** chat_threads, chat_messages, email_messages, settings, models, tasks, triggers
- **Relations:** Proper foreign keys with cascade deletes
- **Migrations:** Drizzle-based with bundled migration system
- **Vector embeddings:** Custom F32_BLOB type for semantic search
- **Encryption:** Built-in with libsql

### AI/LLM Integration
- **Streaming responses** via Vercel AI SDK
- **Tool calling** with MCP protocol
- **Multiple providers** through proxy architecture
- **On-device inference** with Candle/Mistral

### Email System
- **IMAP client** in Rust for email synchronization
- **Email parsing** with mail-parser crate
- **Threading** and conversation management
- **Automation** with triggers and tasks

### Cross-Platform Support
- **Tauri** for native desktop/mobile
- **Feature flags** for conditional compilation
- **Capabilities system** for platform-specific features

## Integration Points

### External Services
- **Google** - Gmail, Calendar, Drive integration via OAuth2
- **Microsoft** - Outlook integration
- **Thunderbolt Pro** - Enhanced features with API access
- **PostHog** - Analytics and telemetry
- **Flower AI** - Federated learning platform

### MCP (Model Context Protocol)
- **Server discovery** and connection management
- **Tool registration** and execution
- **Thunderbird bridge** for email extension integration

## Testing Strategy
- **Vitest** for unit and integration tests
- **Storybook** for component testing and documentation
- **Playwright** for end-to-end testing
- **MSW** for API mocking

## Build & Deploy
- **Development:** `bun tauri dev`
- **Production:** `bun tauri build`
- **Features:** Conditional compilation with Cargo features
- **Signing:** Tauri signing keys for updates
- **CI/CD:** GitHub Actions for automated testing and builds

## Security Considerations
- **Local-first** data storage with encryption
- **CSP policies** in Tauri configuration
- **API key management** through secure settings
- **OAuth flows** with secure token handling

## Performance Optimizations
- **Bundle analysis** with vite-bundle-analyzer
- **Code splitting** for large features
- **Streaming** for LLM responses
- **Vector search** with optimized embeddings
- **Caching** strategies for frequently accessed data

## Common Patterns & Examples

### Error Handling
```typescript
// Preferred error handling at component boundaries
try {
  const result = await apiCall()
  return result
} catch (error) {
  // Log and handle appropriately
  console.error('Operation failed:', error)
  throw error // Let higher-level handlers deal with it
}
```

### Custom Hooks
```typescript
// Pattern for data fetching hooks
export const useData = (id: string) => {
  return useQuery({
    queryKey: ['data', id],
    queryFn: () => fetchData(id),
    enabled: !!id,
  })
}
```

### Settings Management
```typescript
// Typed settings with defaults
const setting = await getSetting('key_name')
await setSetting('key_name', 'value')
```

### Tool Integration
```typescript
// Adding new AI tools
export const newTool: ToolConfig = {
  name: 'new_tool',
  description: 'Tool description for AI understanding',
  verb: 'action_verb',
  parameters: z.object({
    // Zod schema for validation
  }),
  execute: async (params) => {
    // Implementation
  }
}
```

## Development Workflow
1. **Setup:** `make setup` installs all dependencies
2. **Development:** `bun tauri dev` starts dev server
3. **Testing:** `bun test` runs test suite
4. **Linting:** `bun run check` runs type-check, lint, and format-check
5. **Build:** `bun tauri build` creates production bundle

## AI Assistant Context
When working on Thunderbolt, always consider:
- **Local-first architecture** - prefer local solutions
- **Performance implications** of database queries
- **Type safety** - use TypeScript strictly
- **User privacy** - minimize data collection
- **Cross-platform compatibility** - test on multiple platforms
- **Accessibility** - follow WCAG guidelines
- **Code maintainability** - write clear, documented code

This context should provide sufficient information for AI assistants to effectively contribute to the Thunderbolt project while maintaining consistency with established patterns and conventions.