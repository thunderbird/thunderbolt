# Code Conventions & API Patterns

**Development standards and interface patterns across the Thunderbolt codebase**

## Code Conventions

### Naming Conventions

**Files & Directories**:
- **Frontend**: kebab-case (`.tsx`, `.ts`) - `chat-ui.tsx`, `use-database.ts`, `app-sidebar.tsx`
- **Backend**: snake_case (`.py`) - `main.py`, `config.py`, `request_utils.py`
- **Rust**: snake_case - `lib.rs`, `commands.rs`

**Components & Classes**:
- **React Components**: PascalCase - `ChatUI`, `OAuthCallback`, `AppSidebar`
- **Python Classes**: PascalCase - `Settings`, `SearchRequest`, `ProxyService`
- **Functions**: camelCase (TS) / snake_case (Python)

**Variables & Constants**:
- **Variables**: camelCase (TS) / snake_case (Python)
- **Constants**: SCREAMING_SNAKE_CASE across all languages
- **React State**: camelCase - `hasMessages`, `isKeyboardVisible`

### Code Organization

**Frontend Structure**:
```
src/
├── components/          # Reusable UI components
│   ├── ui/             # Base UI primitives (Radix-based)
│   └── chat/           # Domain-specific components
├── hooks/              # Custom React hooks (use-* pattern)
├── lib/                # Utilities, DAL, providers
├── integrations/       # External service integrations
└── db/                 # Database schema & migrations
```

**Backend Structure**:
```
backend/
├── auth/               # Authentication modules
├── pro/                # Pro features & tools
├── tests/              # Test files
├── main.py             # FastAPI entry point
└── config.py           # Settings management
```

### Design Patterns

**Frontend Patterns**:
- **Repository Pattern**: Data access via `src/lib/dal.ts`
- **Singleton Pattern**: Database via `DatabaseSingleton.instance`
- **Provider Pattern**: React Context for dependency injection
- **Hook Pattern**: Custom hooks encapsulate business logic

**Backend Patterns**:
- **Proxy Pattern**: Comprehensive proxy service for API routing
- **Factory Pattern**: Model transformers via factory functions
- **Dependency Injection**: FastAPI `Depends()` for service injection

## API Interface Patterns

### Architecture Style
**Hybrid REST + Proxy Architecture** combining:
- FastAPI backend as REST API + intelligent proxy
- Real-time streaming via Server-Sent Events (SSE)
- Model Context Protocol (MCP) integration

### Endpoint Organization
```
/health                 # Health checks & monitoring
/auth/google/*         # OAuth authentication flows
/pro/*                 # Pro tools (search, weather, content)
/openai/*              # OpenAI-compatible AI proxying
/flower/*              # Flower AI service proxying
/analytics/config      # Public analytics configuration
```

### Request/Response Patterns

**Standard Response Envelope**:
```python
class SearchResponse(BaseModel):
    results: str
    success: bool
    error: str | None = None
```

**TypeScript Tool Configuration**:
```typescript
export type ToolConfig = {
  name: string
  description: string
  verb: string
  parameters: z.ZodObject<any, any>
  execute: (params: any) => Promise<any>
}
```

**Zod Schema Pattern** (always use `.strict()`):
```typescript
export const searchDriveSchema = z.object({
  query: z.string().describe('Search query description'),
  max_results: z.number().optional().default(20),
}).strict()
```

### Error Handling Strategy

**Backend Error Handling**:
```python
try:
    result = await operation()
    return ResponseModel(results=result, success=True)
except Exception as e:
    return ResponseModel(results="", success=False, error=str(e))
```

**Frontend Error Handling**:
- React Error Boundaries for component errors
- Try-catch in async operations with graceful degradation
- User-friendly error messaging

## Tool Integration Pattern

### MCP Tool Development

**1. Define Schema** (`src/integrations/*/tools.ts`):
```typescript
export const toolNameSchema = z.object({
  param: z.string().describe('Parameter description'),
}).strict()
```

**2. Implement Function**:
```typescript
export const toolName = async (params: z.infer<typeof toolNameSchema>) => {
  try {
    const cloudUrl = await getCloudUrl()
    const response = await ky.post(`${cloudUrl}/endpoint`, { json: params })
    // Handle response
  } catch (error) {
    throw new Error(`Operation failed: ${error.message}`)
  }
}
```

**3. Add to Tool Config**:
```typescript
{
  name: 'tool_name',
  description: 'Tool description for AI',
  verb: 'action description for {param}',
  parameters: toolNameSchema,
  execute: toolName,
}
```

### Backend Service Pattern

**1. Create Pydantic Models**:
```python
class RequestModel(BaseModel):
    param: str
    optional_param: int = 10

class ResponseModel(BaseModel):
    results: str
    success: bool
    error: str | None = None
```

**2. Implement Endpoint**:
```python
@router.post("/endpoint", response_model=ResponseModel)
async def endpoint_handler(request: RequestModel):
    try:
        # Business logic
        return ResponseModel(results=result, success=True)
    except Exception as e:
        return ResponseModel(results="", success=False, error=str(e))
```

## Best Practices

### Code Quality
- **TypeScript**: Strict type checking, comprehensive type definitions
- **Python**: Type hints extensively used, Pydantic models for validation
- **Testing**: Consistent naming, comprehensive coverage
- **Error Handling**: Graceful degradation, user-friendly messaging

### Development Workflow
- **Commands**: Use `make` commands for unified development
- **Dependencies**: `bun` for frontend, `uv` for Python, `cargo` for Rust
- **Formatting**: Prettier for TS, Ruff for Python, built-in for Rust
- **Linting**: ESLint for TS, Ruff for Python, Clippy for Rust

### API Design
- **Consistent Response Format**: Always include `success` boolean and optional `error`
- **Input Validation**: Zod schemas for frontend, Pydantic for backend
- **Documentation**: FastAPI auto-generates OpenAPI docs
- **Security**: OAuth 2.0 PKCE, CORS configuration, CSP policies

---

**Quick Reference**:
- **New Tool**: Define schema → implement function → add to config → update MCP bridge
- **New API**: Create models → implement endpoint → add to router → test integration
- **Error Handling**: Try-catch with descriptive messages, never expose internals