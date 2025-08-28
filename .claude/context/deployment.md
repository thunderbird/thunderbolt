# Deployment & Operations

**Cross-platform distribution with containerized backend and comprehensive CI/CD automation**

## Release Management

### Release Candidate Workflow
**Strategy**: Release Candidate (RC) workflow for stable releases
**File**: `RELEASE.md`

**Release Process**:
```bash
# 1. Create Release Candidate
git tag v1.0.0-rc1
git push origin v1.0.0-rc1

# 2. Monitor Automated Build
# - Builds for all platforms (Windows, macOS, Linux)
# - Creates draft release in CrabNebula Cloud
# - Uploads build artifacts

# 3. Final Release (if RC succeeds)
git tag v1.0.0
git push origin v1.0.0
```

**Key Features**:
- **Semantic Versioning**: MAJOR.MINOR.PATCH format
- **RC Tags**: `v*-rc*` pattern triggers automated builds
- **Quality Gates**: All builds must succeed before release
- **Multi-platform**: Windows (x64/ARM64), macOS (Intel/Apple Silicon), Linux

### Environment Management

**Development Setup**:
```bash
make setup    # Initialize submodules and dependencies
make run      # Start backend (8000) and frontend (5173/1420)
make dev      # Alias for run command
```

**Environment Configuration** (`backend/.env.example`):
```bash
# OAuth Configuration
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=

# API Keys
FIREWORKS_API_KEY=
FLOWER_MGMT_KEY=
FLOWER_PROJ_ID=
EXA_API_KEY=

# Server Configuration
LOG_LEVEL=INFO
CORS_ORIGINS="http://localhost:1420"
CORS_ALLOW_CREDENTIALS=true

# Monitoring
MONITORING_TOKEN="your_secret_monitoring_token_here"
POSTHOG_API_KEY=
```

## Cross-Platform Distribution

### Desktop Applications

**Build Targets**:
- **Windows**: MSI and NSIS installers (x64 and ARM64)
- **macOS**: DMG and .app bundles (Intel and Apple Silicon)  
- **Linux**: AppImage, DEB, and RPM packages

**Build Commands**:
```bash
make build-desktop              # Default build
make build-desktop-target TARGET=x86_64-pc-windows-msvc
make build-desktop-full BUNDLES=msi,nsis TARGET=x86_64-pc-windows-msvc
```

### Mobile Applications

**iOS Deployment**:
```bash
make build-ios                  # iOS build with App Store Connect export
```

**Configuration**:
- **iOS**: App Store Connect export method
- **Android**: Android build support via Tauri
- **Cross-platform**: Single codebase for all platforms

## Containerization Strategy

### Backend Docker Configuration

**Development Docker** (`backend/Dockerfile`):
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
RUN pip install uv && uv sync --frozen
EXPOSE 8000
CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0"]
```

**Production Docker** (`backend/Dockerfile.prod`):
```dockerfile
FROM python:3.12-slim
# Optimized for production with Gunicorn
RUN pip install uv
COPY . .
RUN uv sync --frozen --no-dev
CMD ["uv", "run", "gunicorn", "main:app", "-k", "uvicorn.workers.UvicornWorker"]
```

**Docker Compose** (`backend/docker-compose.yml`):
```yaml
services:
  thunderbolt-backend:
    build: .
    ports:
      - "8000:8000"
    environment:
      - LOG_LEVEL=INFO
    volumes:
      - .:/app
    restart: unless-stopped
```

**Resource Limits**:
- **Memory**: 512MB limit for backend container
- **CPU**: 1 CPU core allocation
- **Storage**: Volume mounts for development

## CI/CD Pipeline

### GitHub Actions Workflows

**Release Pipeline** (`.github/workflows/release.yml`):
- **Trigger**: Tags matching `v*` pattern
- **Platforms**: Multi-platform builds (Windows, macOS, Linux)
- **Integration**: Tauri v2 release process
- **Distribution**: CrabNebula Cloud integration

**iOS Deployment** (`.github/workflows/ios-deployment.yml`):
- **Build**: iOS app compilation  
- **Export**: App Store Connect integration
- **Distribution**: TestFlight and App Store

**Key Features**:
- **Parallel Builds**: Multiple platforms simultaneously
- **Artifact Management**: Automated artifact collection
- **Release Drafting**: Automatic release note generation
- **Security**: Secure secret management

### Build Automation

**Quality Checks**:
```bash
make check          # All quality checks (format, lint, type-check, test)
make lint           # Code linting
make format-check   # Format validation
make test           # Full test suite
```

**Multi-Language Support**:
- **Frontend**: Bun for package management and building
- **Backend**: UV for Python dependency management
- **Rust**: Cargo for native modules and Tauri app

## Infrastructure & Cloud Integration

### Cloud Services

**CrabNebula Cloud**:
- **Release Management**: Integrated release distribution
- **Artifact Storage**: Build artifact hosting
- **Analytics**: Usage and crash reporting
- **Updates**: Automatic update delivery

**External APIs**:
- **Flower AI**: Proxy endpoints for AI model inference
- **PostHog Analytics**: Privacy-compliant usage tracking
- **OAuth Providers**: Google and Microsoft authentication
- **Weather Service**: Open-Meteo API integration

### Monitoring & Health Checks

**Health Endpoints**:
```python
@app.get("/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.utcnow()}

@app.get("/health/detailed")
async def detailed_health(token: str = Query(...)):
    # Protected health check with monitoring token
    if token != settings.monitoring_token:
        raise HTTPException(401, "Invalid monitoring token")
    return {"status": "healthy", "services": service_status}
```

**Logging Configuration**:
- **Level**: Configurable via LOG_LEVEL environment variable
- **Format**: Structured logging for production
- **Privacy**: No sensitive data in logs

## Development Tools

### Version Management

**Mise Configuration** (`mise.local.toml`):
```toml
[tools]
node = "22"
python = "3.12"
bun = "1.1.38"
```

**Dependency Management**:
- **Frontend**: `bun` for fast package management
- **Backend**: `uv` for modern Python dependency resolution
- **Rust**: `cargo` with workspace organization

### Development Automation

**Unified Commands** (`Makefile`):
```bash
setup:      # Initialize project and dependencies
install:    # Install dependencies
build:      # Production builds
clean:      # Clean build artifacts
test:       # Run test suites
lint:       # Code quality checks
format:     # Code formatting
```

**Hot Reload**:
- **Frontend**: Vite HMR (Hot Module Replacement)
- **Backend**: uvicorn reload for API changes
- **Database**: Automatic migration bundling

## Deployment Best Practices

### Security Considerations
1. **Environment Variables**: All secrets via environment variables
2. **CORS Configuration**: Environment-specific CORS settings
3. **Token Management**: Secure OAuth token storage
4. **Monitoring**: Protected health checks with authentication

### Performance Optimization
1. **Build Optimization**: Production builds with minification
2. **Asset Optimization**: Static asset compression
3. **Database Optimization**: Local-first with LibSQL encryption
4. **Caching**: Intelligent caching strategies

### Scalability Patterns
1. **Containerization**: Docker for consistent deployment
2. **Resource Management**: Container resource limits
3. **Load Balancing**: Ready for horizontal scaling
4. **Database**: SQLite → PostgreSQL migration path

---

**Deployment Commands**:
- `make build-desktop` - Build desktop application
- `make build-android` - Build Android application  
- `make build-ios` - Build iOS application with App Store export
- `docker-compose up` - Start containerized backend