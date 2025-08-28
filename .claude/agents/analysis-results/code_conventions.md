Now I have enough information to provide a comprehensive analysis of the code conventions and patterns in the Thunderbolt codebase. Let me create the comprehensive markdown document.

# Code Conventions and Patterns Analysis: Thunderbolt

Based on my analysis of the Thunderbolt codebase, here's a comprehensive documentation of the code conventions and patterns observed across the project.

## 1. Naming Conventions

### File and Directory Naming Patterns

**Frontend (TypeScript/React):**
- **Components**: kebab-case with `.tsx` extension (`chat-ui.tsx`, `oauth-callback.tsx`, `app-sidebar.tsx`)
- **Hooks**: kebab-case with `use-` prefix (`use-database.ts`, `use-auto-scroll.tsx`, `use-mcp-sync.tsx`)
- **Utilities**: kebab-case (`utils.ts`, `dal.ts`, `analytics.tsx`)
- **Test files**: Same as source with `.test.ts` suffix (`analytics.test.ts`, `flower.test.ts`)
- **UI components**: kebab-case in `ui/` directory (`button.tsx`, `alert-dialog.tsx`)
- **Directory structure**: kebab-case (`src-tauri/`, `chat-ui/`, `streaming/`)

**Backend (Python):**
- **Modules**: snake_case (`main.py`, `config.py`, `request_utils.py`)
- **Directories**: snake_case (`pro/`, `auth/`, `tests/`)

**Rust:**
- **Files**: snake_case (`lib.rs`, `main.rs`, `commands.rs`)
- **Directories**: snake_case (`thunderbolt_embeddings/`, `thunderbolt_email/`)

### Class/Module/Component Naming

**TypeScript Components:**
- **React components**: PascalCase (`ChatUI`, `OAuthCallback`, `AppSidebar`)
- **Default exports**: PascalCase function name matches file purpose
```typescript
export default function Layout() { /* ... */ }
export default function ChatUI({ chatHelpers, models, ... }: ChatUIProps) { /* ... */ }
```

**Python Classes:**
- **Classes**: PascalCase (`Settings`, `SearchRequest`, `ProxyConfig`)
- **Pydantic models**: PascalCase with descriptive suffixes (`SearchRequest`, `WeatherResponse`)

### Function/Method Naming

**TypeScript:**
- **Functions**: camelCase (`getSelectedModel`, `convertUIMessageToDbChatMessage`, `sanitizeUrl`)
- **React hooks**: camelCase with `use` prefix (`useDatabase`, `useAutoScroll`)
- **Event handlers**: camelCase with `handle` prefix (`handleSubmit`, `handleClearDatabase`)

**Python:**
- **Functions**: snake_case (`get_settings`, `build_user_id_hash`, `create_model_transformer`)
- **Async functions**: snake_case with consistent async/await pattern

### Variable and Constant Naming

**TypeScript:**
- **Variables**: camelCase (`chatHelpers`, `isStreaming`, `selectedModelId`)
- **Constants**: SCREAMING_SNAKE_CASE for global constants
```typescript
const THUNDERBOLT_MODEL_WHITELIST = {
  "qwen3-235b-a22b-instruct-2507",
  // ...
}
```
- **React state**: camelCase (`hasMessages`, `isKeyboardVisible`)

**Python:**
- **Variables**: snake_case (`proxy_service`, `user_id_hash`, `model_name`)
- **Constants**: SCREAMING_SNAKE_CASE (`THUNDERBOLT_MODEL_WHITELIST`)

### Configuration and Environment Variable Patterns

**Environment Variables:**
- Snake case format: `FIREWORKS_API_KEY`, `FLOWER_MGMT_KEY`, `POSTHOG_API_KEY`
- Settings class uses descriptive names matching env vars but lowercase with underscores

**Database Naming:**
- **Tables**: snake_case (`chat_threads`, `email_messages`, `settings`)
- **Columns**: snake_case (`chat_thread_id`, `first_seen_at`, `is_encrypted`)

## 2. Code Organization Patterns

### Functionality Grouping

**Frontend Structure:**
```
src/
├── components/          # Reusable UI components
│   ├── ui/             # Base UI primitives (buttons, dialogs, etc.)
│   └── chat/           # Chat-specific components
├── hooks/              # Custom React hooks
├── lib/                # Utility functions and services
├── integrations/       # Third-party service integrations
├── db/                 # Database layer and ORM
├── types/              # TypeScript type definitions
└── pages/              # Route-specific pages
```

**Backend Structure:**
```
backend/
├── auth/               # Authentication modules
├── pro/                # Pro features and tools
├── tests/              # Test files
├── main.py             # FastAPI application entry
├── config.py           # Configuration management
└── proxy.py            # Proxy service implementation
```

### Inheritance and Composition Patterns

**React Components:**
- **Composition over inheritance**: Components use props and children patterns
- **HOC pattern**: Provider components wrap functionality (`ThemeProvider`, `MCPProvider`)
- **Compound components**: Complex UI built from smaller, focused components

```typescript
// Example from chat-ui.tsx showing composition
<PromptInput
  ref={formRef}
  value={input}
  onChange={(value: string) => setInput(value)}
  models={models}
  selectedModelId={selectedModelId}
  onModelChange={onModelChange}
  // ... more props
/>
```

**Python Classes:**
- **Inheritance from Pydantic BaseModel**: Consistent data validation pattern
```python
class SearchRequest(BaseModel):
    query: str
    max_results: int = 10
```

### Interface/Contract Definitions

**TypeScript Types:**
- **Extensive use of type definitions** in `types.ts`
- **Database schema types** derived from Drizzle ORM
```typescript
export type ChatMessage = InferSelectModel<typeof chatMessagesTable>
export type Model = InferSelectModel<typeof modelsTable>
```

**Tool Configuration Pattern:**
```typescript
export type ToolConfig = {
  name: string
  description: string
  verb: string
  parameters: z.ZodObject<any, any>
  execute: (params: any) => Promise<any>
}
```

### Dependency Injection/Management Patterns

**Frontend:**
- **Context providers**: React Context for dependency injection
- **Singleton pattern**: Database connection management via `DatabaseSingleton`
- **Custom hooks**: Encapsulate data access and business logic

**Backend:**
- **FastAPI dependency injection**: Using `Depends()` for service injection
```python
async def proxy_endpoint(
    proxy_service: ProxyService = Depends(get_proxy_service),
) -> Any:
```

## 3. Architectural Patterns

### Design Patterns in Use

**Repository Pattern:**
- Data Access Layer (DAL) in `src/lib/dal.ts` abstracts database operations
```typescript
export const getSelectedModel = async (): Promise<Model> => {
  const db = DatabaseSingleton.instance.db
  // Database query logic
}
```

**Factory Pattern:**
- Model transformers created via factory functions
```python
def create_model_transformer(
    prefix: str, check_prefix: str | None = None
) -> Callable[[bytes], bytes]:
```

**Proxy Pattern:**
- Comprehensive proxy service for API routing and transformation
```python
class ProxyService:
    def register_proxy(self, path: str, config: ProxyConfig) -> None:
```

**Observer Pattern:**
- React's state management and effect system
- Custom hooks for reactive data

### Separation of Concerns Approach

**Clear Layer Separation:**
1. **Presentation Layer**: React components in `components/`
2. **Business Logic**: Custom hooks and utility functions in `lib/`
3. **Data Access**: Database operations in `db/` and `dal.ts`
4. **External Services**: Integrations in `integrations/`

**Backend Separation:**
1. **API Layer**: FastAPI routes and endpoints
2. **Business Logic**: Service classes and utilities
3. **Configuration**: Centralized in `config.py`
4. **Authentication**: Isolated in `auth/` module

### Data Access Patterns

**ORM Pattern with Drizzle:**
```typescript
export const chatThreadsTable = sqliteTable('chat_threads', {
  id: text('id').primaryKey().notNull().unique(),
  title: text('title'),
  isEncrypted: integer('is_encrypted').default(0).notNull(),
})
```

**Query Builder Pattern:**
```typescript
const model = await db
  .select()
  .from(modelsTable)
  .where(eq(modelsTable.id, selectedModelId))
  .get()
```

### Error Handling Strategies

**Frontend Error Handling:**
- **React Error Boundaries**: Catch and handle component errors
- **Try-catch in async operations**: Graceful degradation
```typescript
try {
  const newInitData = await init()
  setInitData(newInitData)
} catch (error) {
  console.error('Failed to initialize app:', error)
  setInitError(error)
}
```

**Backend Error Handling:**
- **HTTPException for API errors**: Consistent error responses
```python
if not settings.flower_mgmt_key or not settings.flower_proj_id:
    raise HTTPException(status_code=503, detail="Flower AI not configured")
```

## 4. Code Style Standards

### Indentation and Formatting

**TypeScript/JavaScript:**
- **2-space indentation** consistently used
- **Prettier formatting** with configuration in `package.json`
- **ESLint rules** defined in `eslint.config.js`

**Python:**
- **4-space indentation** following PEP 8
- **Type hints** extensively used
```python
async def search_locations(query: str) -> Any:
```

### Comment and Documentation Patterns

**JSDoc Comments:**
```typescript
/**
 * Split UI part types like "tool-read_file" into [type, name]
 */
export const splitPartType = (type: string): [string, string] => {
```

**Python Docstrings:**
```python
"""
Pydantic models for Pro Tools API requests and responses
"""
```

**Inline Comments:**
- Used sparingly, focusing on business logic rather than obvious code
- Explain "why" rather than "what"

### Import/Include Organization

**TypeScript Import Order:**
1. External libraries (`react`, `ky`, etc.)
2. Internal absolute imports (`@/components`, `@/lib`)
3. Relative imports (`./utils`, `../types`)

```typescript
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { Model, type Prompt, type ThunderboltUIMessage } from '@/types'
import type { UseChatHelpers } from '@ai-sdk/react'
```

**Python Import Order:**
1. Standard library imports
2. Third-party imports
3. Local application imports

```python
import json
import logging
from collections.abc import Callable

import httpx
from fastapi import APIRouter, Depends, FastAPI

import config
from auth import google_router, microsoft_router
```

### Method/Function Organization Within Files

**Frontend Components:**
1. **Imports**
2. **Type definitions/interfaces**
3. **Constants**
4. **Helper/utility functions**
5. **Main component function**
6. **Export statements**

**Backend Modules:**
1. **Module docstring**
2. **Imports**
3. **Constants**
4. **Helper functions**
5. **Main logic/classes**
6. **Export statements**

## Key Observations

1. **Consistent TypeScript usage**: Strong typing throughout with comprehensive type definitions
2. **Modern React patterns**: Hooks, functional components, context providers
3. **Clean architecture**: Clear separation between presentation, business logic, and data access
4. **Test-driven approach**: Comprehensive test coverage with consistent naming
5. **Configuration management**: Centralized settings with environment variable support
6. **Error handling**: Graceful error handling with user-friendly messaging
7. **Performance considerations**: Optimistic updates, memoization, and efficient state management
8. **Cross-platform support**: Tauri integration for desktop, with mobile considerations

The codebase demonstrates high-quality engineering practices with consistent patterns, strong typing, and clear architectural boundaries that facilitate maintainability and scalability.