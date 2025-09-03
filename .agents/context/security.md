# Security & Authorization

**Multi-layered security architecture with OAuth authentication and privacy-first design**

## Authentication Architecture

### OAuth 2.0 with PKCE Implementation
**Primary Flow**: OAuth 2.0 Authorization Code Flow with PKCE (Proof Key for Code Exchange)
**Providers**: Google and Microsoft OAuth integrations
**Location**: `src/lib/auth.ts`

**PKCE Security Features**:
```typescript
// RFC 7636 compliant code verifier generation
const generateCodeVerifier = (): string => {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// SHA-256 code challenge
const generateCodeChallenge = async (verifier: string): Promise<string> => {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
```

### Provider-Specific Security

**Google OAuth** (`src/integrations/google/auth.ts`):
- **Scopes**: Gmail, Calendar, Drive permissions
- **Endpoints**: Google's official OAuth 2.0 endpoints
- **Token Management**: Secure refresh token handling

**Microsoft OAuth** (`src/integrations/microsoft/auth.ts`):
- **Scopes**: Microsoft Graph API access
- **Endpoints**: Microsoft OAuth 2.0 v2.0
- **Integration**: Azure AD authentication

### Backend Token Exchange

**Secure Token Management** (`backend/auth/`):
```python
@router.post("/exchange", response_model=OAuthTokenResponse)
async def exchange_code(
    body: CodeRequest, settings: Settings = Depends(get_settings)
) -> OAuthTokenResponse:
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(
            status_code=503,
            detail="Google OAuth not configured"
        )
    # Secure token exchange implementation
```

**Security Features**:
- Client secrets kept secure on backend
- Token refresh mechanism implemented
- Proper error handling and logging
- State parameter validation

## Authorization Mechanisms

### Role-Based Access Control

**Token-Based Authorization**:
- OAuth access tokens for API access
- Refresh tokens for session persistence
- Scope-based permission validation

**State Management**:
- Session storage for temporary state
- LocalStorage for persistent tokens
- Memory-only sensitive data handling

### API Authorization

**Backend Route Protection**:
```python
async def validate_google_token(token: str) -> dict:
    """Validate Google OAuth token and return user info"""
    try:
        response = await httpx.get(
            "https://www.googleapis.com/oauth2/v1/userinfo",
            headers={"Authorization": f"Bearer {token}"}
        )
        if response.status_code != 200:
            raise HTTPException(401, "Invalid token")
        return response.json()
    except Exception as e:
        raise HTTPException(401, f"Token validation failed: {e}")
```

## Security Best Practices

### Input Validation

**Frontend Validation** (Zod schemas):
```typescript
export const searchDriveSchema = z.object({
  query: z.string().describe('Search query'),
  max_results: z.number().optional().default(20),
}).strict()  // Always use .strict() for security
```

**Backend Validation** (Pydantic models):
```python
class SearchRequest(BaseModel):
    query: str
    max_results: int = Field(default=10, ge=1, le=100)
```

### CORS Configuration

**Backend CORS Settings** (`backend/config.py`):
```python
# CORS settings
cors_origins: str = "http://localhost:1420"
cors_origin_regex: str = ""
cors_allow_credentials: bool = True
cors_allow_methods: str = "GET,POST,PUT,DELETE,PATCH,OPTIONS"
cors_allow_headers: str = "*"
cors_expose_headers: str = "mcp-session-id"
```

**Security Features**:
- Credential-enabled CORS for OAuth
- Specific origin configuration
- Custom header exposure for MCP protocol

### Content Security Policy

**Tauri CSP Configuration**:
- Strict CSP policies for desktop app
- Resource loading restrictions
- Script execution limitations
- Network access controls

## Data Protection

### Encryption at Rest

**Database Encryption**:
- LibSQL with encryption support
- Local-first data storage
- Encrypted user data and preferences

**Configuration Security**:
- API keys in environment variables
- No sensitive data in repository
- Secure settings management

### Privacy-First Architecture

**Local Processing**:
- On-device AI embeddings (Candle framework)
- Local email storage and indexing
- Minimal cloud data exposure

**Data Minimization**:
- Only authentication requires external services
- User data remains local by default
- Optional cloud features with explicit consent

## Monitoring & Health Checks

### Health Check Security

**Monitoring Token** (`backend/config.py`):
```python
monitoring_token: str = ""  # Secret token for health check endpoints
```

**Protected Endpoints**:
- Health checks require authentication
- Internal monitoring via secure tokens
- System status without data exposure

### Analytics Privacy

**PostHog Integration**:
- Privacy-compliant usage tracking
- Anonymous user identification
- Configurable analytics (debug_posthog setting)
- User consent and opt-out support

## Security Vulnerabilities & Mitigations

### Common Threats Addressed

**CSRF Protection**:
- State parameter in OAuth flows
- Same-origin policy enforcement
- CSRF token validation

**XSS Prevention**:
- Input sanitization and validation
- CSP headers implementation
- React's built-in XSS protection

**Token Security**:
- Secure token storage patterns
- Automatic token refresh
- Token expiration handling

### Security Recommendations

**Development Practices**:
1. **Always validate input** with Zod/Pydantic schemas
2. **Use HTTPS** for all external communications  
3. **Minimize token scope** to required permissions
4. **Implement token refresh** for long-lived sessions
5. **Log security events** without exposing sensitive data

**Deployment Security**:
1. **Environment variable management** for secrets
2. **CORS configuration** specific to deployment environment
3. **CSP policies** tailored to application needs
4. **Regular security updates** for dependencies

---

**Security Commands**:
- `make check` - Run security linting and validation
- `bun audit` - Check for frontend vulnerabilities  
- `cd backend && uv audit` - Backend security audit
- Health check: `GET /health` with monitoring token