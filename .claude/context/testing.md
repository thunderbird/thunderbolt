# Testing Patterns & QA Practices

**Comprehensive testing strategy across frontend, backend, and Rust components**

## Testing Frameworks

### Frontend Testing
- **Primary**: Bun Test (built-in testing capabilities)
- **Browser Testing**: Playwright integration via Storybook
- **Mocking**: MSW (Mock Service Worker) for API mocking
- **Configuration**: `vite.config.ts` with Vitest configuration

### Backend Testing (Python)
- **Primary**: pytest with asyncio support
- **Coverage**: pytest-cov (15% minimum baseline)
- **Configuration**: `/backend/pytest.ini` with function-scoped fixtures
- **Async Testing**: `httpx` for async HTTP testing

### Rust Testing
- **Primary**: Standard Rust test framework with Tokio
- **Integration Tests**: Located in `src-tauri/thunderbolt_bridge/tests/`
- **Categories**: Unit tests, integration tests, MCP tests, WebSocket tests

## Test Organization

### Directory Structure
```
├── src/                           # Frontend tests co-located
│   ├── ai/middleware/tool-calls.test.ts
│   ├── ai/streaming/sse-logs.test.ts
│   ├── flower/flower.test.ts
│   └── integrations/google/tools.test.ts
├── backend/tests/                 # Backend tests in dedicated directory
│   ├── conftest.py               # Pytest fixtures
│   ├── test_main.py
│   ├── test_proxy.py
│   └── test_healthcheck.py
└── src-tauri/thunderbolt_bridge/tests/  # Rust integration tests
```

### Naming Conventions
- **Frontend**: `*.test.ts` (co-located with source)
- **Backend**: `test_*.py` (in dedicated test directory)
- **Rust**: `*_test.rs` (in `tests/` directories)
- **Storybook**: `*.stories.tsx` for component stories

## Testing Patterns

### Unit Test Structure

**Frontend (Bun Test)**:
```typescript
import { describe, expect, it } from 'bun:test'
import { toolCallsMiddleware } from './tool-calls'

describe('toolCallsMiddleware', () => {
  it('should process tool calls correctly', () => {
    // Test implementation
  })
})
```

**Backend (pytest)**:
```python
import pytest
from fastapi.testclient import TestClient

@pytest.mark.asyncio
async def test_endpoint():
    # Async test implementation
    assert response.status_code == 200
```

**Rust Tests**:
```rust
#[tokio::test]
async fn test_mcp_integration() {
    // Async Rust test with Tokio
}
```

### Component Testing (Storybook)

**Story Definition**:
```typescript
export default {
  title: 'Components/ChatUI',
  component: ChatUI,
} as ComponentMeta<typeof ChatUI>
```

**Automated Testing**: Storybook stories with `@storybook/addon-vitest`
**Visual Regression**: Playwright browser testing

### Snapshot Testing

**SSE Parsing Validation**:
```typescript
// Uses Bun snapshots for SSE parsing validation
it('parses SSE correctly', () => {
  const parsed = parseSSEChunk(sseData)
  expect(parsed).toMatchSnapshot()
})
```

## Test Categories

### 1. Unit Tests
- **Frontend**: Component logic, utility functions, hooks
- **Backend**: Service functions, model validation, utilities
- **Rust**: Individual function testing, data structures

### 2. Integration Tests
- **MCP Protocol**: End-to-end tool execution flows
- **API Integration**: Frontend ↔ Backend communication
- **Database**: ORM operations and migrations

### 3. Component Tests
- **Storybook Stories**: Interactive component documentation
- **Browser Testing**: Real browser environment via Playwright
- **Visual Regression**: Automated screenshot comparison

### 4. End-to-End Testing
- **Full Flow Testing**: User workflows (chat, email, auth)
- **Cross-Component**: Multiple system integration
- **Performance Testing**: Load and stress testing scenarios

## Testing Best Practices

### Data Management
- **Test Fixtures**: Centralized in `conftest.py` (Python)
- **Mock Data**: Consistent test data generation
- **Database Isolation**: Test database separation

### Coverage Requirements
- **Minimum**: 15% baseline coverage (conservative)
- **Target Areas**: Critical business logic, API endpoints
- **Reporting**: HTML, XML, and terminal coverage reports

### CI/CD Integration
- **Automated Testing**: All tests run on commits and PRs
- **Build Blocking**: Tests must pass for releases
- **Performance Monitoring**: Test execution time tracking

### Quality Gates
- **Type Safety**: TypeScript strict mode, Python type hints
- **Linting**: ESLint (frontend), Ruff (backend), Clippy (Rust)
- **Formatting**: Prettier, Ruff, built-in Rust formatting

## Testing Commands

### Development
```bash
# Frontend tests
bun test                    # Run all frontend tests
bun test --watch           # Watch mode

# Backend tests
cd backend && make test    # Run pytest with coverage
make test-cov             # Coverage reporting

# Rust tests
cargo test                # All Rust tests
cargo test --workspace    # Workspace-wide testing
```

### CI/CD Pipeline
```bash
make check                # Run all quality checks
make test                 # Full test suite
```

---

**Key Insights**:
- **Multi-Language Testing**: Unified approach across TypeScript, Python, and Rust
- **Co-location Strategy**: Frontend tests near source, backend in dedicated directory
- **Comprehensive Coverage**: Unit → Integration → E2E testing pipeline
- **Quality Focus**: Emphasis on maintainable, reliable test patterns