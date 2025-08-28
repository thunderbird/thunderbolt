Based on my comprehensive analysis of the Thunderbolt codebase, I can now provide a detailed report on the API and interface patterns. Here's my comprehensive markdown analysis:

# API and Interface Patterns in Thunderbolt

## Overview

Thunderbolt is a modern email client built with a hybrid architecture combining a Python FastAPI backend with a TypeScript/React frontend using Tauri for desktop deployment. The codebase demonstrates sophisticated API patterns including proxy services, streaming protocols, OAuth integration, and Model Context Protocol (MCP) support.

---

## 1. API Architecture and Design

### Architectural Style
- **Hybrid REST + Proxy Architecture**: The backend serves as both a REST API and intelligent proxy service
- **Microservices Pattern**: Modular design with separate routers for authentication, pro tools, and proxy services
- **Event-Driven Streaming**: Real-time AI interactions via Server-Sent Events (SSE) and WebSocket proxying

### Primary Components

**Backend (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/backend/main.py`)**:
```python
app = FastAPI(
    title="Thunderbolt Backend", 
    description="A FastAPI backend with proxy capabilities",
    version="0.1.0",
    lifespan=proxy_lifespan
)
```

**Endpoint Organization**:
- `/health` - Health check endpoints
- `/auth/google/*` - OAuth authentication flows  
- `/auth/microsoft/*` - Microsoft OAuth (future)
- `/pro/*` - Pro tools (search, weather, content fetching)
- `/openai/*` - OpenAI-compatible AI model proxying
- `/flower/*` - Flower AI service proxying
- `/posthog/*` - Analytics service proxying
- `/locations` - Location geocoding services
- `/analytics/config` - Public analytics configuration

### Request/Response Patterns

**Standard Response Envelope** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/backend/pro/models.py`):
```python
class SearchResponse(BaseModel):
    results: str
    success: bool
    error: str | None = None
```

**Consistent Error Handling**:
```python
try:
    # Operation logic
    return SearchResponse(results=formatted, success=True)
except Exception as e:
    return SearchResponse(results="", success=False, error=str(e))
```

### Version Management
- **Semantic Versioning**: Backend uses "0.1.0" version
- **Model Versioning**: AI models use provider-specific versioning (e.g., `accounts/fireworks/models/`)
- **No API Versioning**: Currently single version deployment

---

## 2. Interface Definitions

### API Contract Definitions

**Pydantic Models for Type Safety** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/backend/pro/models.py`):
```python
class SearchRequest(BaseModel):
    query: str
    max_results: int = 10

class WeatherRequest(BaseModel):
    location: str
    days: int = 3  # Only used for forecast
```

**Frontend TypeScript Types** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/src/types.ts`):
```typescript
export type ThunderboltUIMessage = UIMessage<UIMessageMetadata, UIDataTypes, UITools>
export type SaveMessagesFunction = ({ id, messages }: { 
  id: string; 
  messages: ThunderboltUIMessage[] 
}) => Promise<void>
```

### Input/Output Data Structures

**Complex Nested Schemas** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/src/integrations/google/tools.ts`):
```typescript
export const searchDriveSchema = z.object({
  query: z.string().describe(`Google Drive search query using Google's native API syntax...`),
  max_results: z.number().optional().default(20),
  include_trashed: z.boolean().optional().default(false),
}).strict()
```

**Database Schema Definitions** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/src/db/tables.ts`):
```typescript
export const chatMessagesTable = sqliteTable('chat_messages', {
  id: text('id').primaryKey().notNull().unique(),
  content: text('content').notNull(),
  role: text('role').notNull().$type<UIMessage['role']>(),
  parts: text('parts', { mode: 'json' }).$type<UIMessage['parts']>(),
  chatThreadId: text('chat_thread_id')
    .notNull()
    .references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
})
```

### Validation and Sanitization

**Zod Schema Validation**:
```typescript
export const checkInboxSchema = z.object({
  label: z.string().optional().default('INBOX'),
  max_results: z.number().optional().default(20),
  include_spam_trash: z.boolean().optional().default(false),
}).strict()
```

**Server-Side Validation**:
```python
# Automatic validation via Pydantic models
@app.post("/search-duckduckgo", response_model=SearchResponse)
async def search_endpoint(request: SearchRequest) -> SearchResponse:
```

---

## 3. Integration Patterns

### External Service Integration

**Proxy-Based Architecture** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/backend/proxy.py`):
```python
class ProxyConfig:
    def __init__(self,
        target_url: str,
        api_key: str,
        api_key_header: str = "Authorization",
        supports_streaming: bool = False,
        request_transformer: Callable[[bytes], bytes] | None = None,
    ):
```

**Service Registration Pattern**:
```python
proxy_service.register_proxy("/openai", ProxyConfig(
    target_url="https://api.fireworks.ai/inference/v1",
    api_key=settings.fireworks_api_key,
    supports_streaming=True,
    request_transformer=create_model_transformer(prefix="accounts/fireworks/models/")
))
```

### Authentication and Authorization Patterns

**OAuth 2.0 PKCE Flow** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/backend/auth/google.py`):
```python
@router.post("/exchange", response_model=OAuthTokenResponse)
async def exchange_code(body: CodeRequest, settings: Settings = Depends(get_settings)):
    data = {
        "code": body.code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": body.redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": body.code_verifier,
    }
```

**Token Management**:
```python
class OAuthTokenResponse(BaseModel):
    access_token: str
    refresh_token: str | None = None
    expires_in: int
    token_type: str
    scope: str | None = None
```

### Rate Limiting and Throttling

**Client-Side Rate Limiting** (via proxy service):
- HTTP/2 connection pooling
- Connection limits: `max_connections=100, max_keepalive_connections=20`
- Request timeout: `30.0s connect, 5.0s timeout`

### Error Handling and Status Codes

**Structured Error Responses**:
```python
except httpx.HTTPStatusError as e:
    error_data = e.response.json() if e.response.content else {}
    error_msg = error_data.get("error_description", str(e))
    raise HTTPException(
        status_code=400, 
        detail=f"Token exchange failed: {error_msg}"
    )
```

**Custom Error Transformations**:
```python
# Transform Fireworks 500 errors to user-friendly 503
if response.status_code == 500 and "fireworks" in target_url:
    error_response = {
        "error": {
            "code": "SERVICE_UNAVAILABLE",
            "message": "AI service is temporarily offline. Please try again later.",
            "type": "service_error",
        }
    }
```

---

## 4. Serialization and Communication

### Data Serialization Formats

**JSON as Primary Format**:
- Request/response bodies: JSON
- Database JSON fields: `text('parts', { mode: 'json' })`
- Configuration: JSON with environment variable fallbacks

**Binary Data Handling**:
```typescript
export const float32Array = customType<{
  data: number[]
  config: { dimensions: number }
}>({
  dataType(config) { return `F32_BLOB(${config.dimensions})` },
  fromDriver(value: Buffer) { return Array.from(new Float32Array(value.buffer)) },
})
```

### Communication Protocols

**HTTP/1.1 and HTTP/2 Support**:
```python
# Proxy service with HTTP/2 capability
self.client = httpx.AsyncClient(
    http2=http2_available,  # Enable HTTP/2 if available
    follow_redirects=True,
    limits=httpx.Limits(max_keepalive_connections=20, max_connections=100)
)
```

**WebSocket Proxying** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/backend/proxy_websocket.py`):
```python
async def proxy_websocket(self, client_websocket: WebSocket, path: str, config: WebSocketProxyConfig):
    target_url = f"{config.target_url.replace('http', 'ws')}/{path}"
    async with websockets.connect(target_url, extra_headers=headers) as target_websocket:
        # Bidirectional message forwarding
        await asyncio.gather(forward_to_target(), forward_to_client())
```

### Streaming and Real-time Patterns

**Server-Sent Events for AI Streaming**:
```python
async def _proxy_streaming(self, request: Request, path: str, config: ProxyConfig):
    return StreamingResponse(
        body_iter(),
        status_code=upstream.status_code,
        media_type=media_type,
        headers=upstream_headers,
    )
```

**AI SDK Integration** (`/Users/robertjacques/RootsystemProjects/MozillaThunderbolt/thunderbolt/src/ai/fetch.ts`):
```typescript
const result = streamText({
  temperature: 0.25,
  model: wrappedModel,
  system: systemPrompt,
  messages: convertToModelMessages(messages),
  tools: supportsTools ? toolset : undefined,
  abortSignal,
})

return result.toUIMessageStreamResponse<ThunderboltUIMessage>({
  sendReasoning: true,
  messageMetadata: () => ({ modelId }),
})
```

### Caching Strategies

**Configuration Caching**:
```python
@lru_cache
def get_settings() -> Settings:
    return Settings()
```

**HTTP Client Singleton**:
```typescript
let singleton: typeof ky | null = null
export const getHttpClient = async (): Promise<typeof ky> => {
  if (singleton) return singleton
  singleton = ky.create({ prefixUrl: cloudUrl })
  return singleton
}
```

---

## Key Design Principles

1. **Type Safety First**: Comprehensive TypeScript/Pydantic type definitions
2. **Proxy-Driven Architecture**: Intelligent request routing and transformation
3. **Streaming-Ready**: Built for real-time AI and WebSocket communication
4. **Modular Authentication**: Pluggable OAuth providers
5. **Error Resilience**: Structured error handling with user-friendly transformations
6. **Performance Optimized**: Connection pooling, HTTP/2, and intelligent caching
7. **Protocol Agnostic**: Support for REST, WebSocket, and MCP protocols

The Thunderbolt codebase represents a sophisticated implementation of modern API patterns, particularly excelling in AI service integration, real-time communication, and secure authentication flows.