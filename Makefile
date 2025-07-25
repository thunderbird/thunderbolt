.PHONY: help setup install build build-desktop build-android build-ios clean run dev

# Color definitions
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m # No Color

# Default target
help:
	@echo "Available commands:"
	@echo "  make setup          - Initialize submodules and install all dependencies"
	@echo "  make install        - Install frontend dependencies"
	@echo "  make run            - Start both backend and frontend development servers"
	@echo "  make dev            - Alias for 'make run'"
	@echo "  make build          - Build frontend for production"
	@echo "  make build-desktop  - Build Tauri desktop app"
	@echo "  make build-android  - Build Tauri Android app"
	@echo "  make build-ios      - Build Tauri iOS app"
	@echo "  make clean          - Clean build artifacts"

# Setup project - initialize submodules and install all dependencies
setup:
	@echo "$(BLUE)→ Initializing git submodules...$(NC)"
	git submodule update --init --recursive
	@echo "$(BLUE)→ Installing frontend dependencies...$(NC)"
	bun install
	@echo "$(BLUE)→ Installing backend dependencies...$(NC)"
	cd backend && uv sync --frozen
	@echo "$(BLUE)→ Setting up Flower framework (optional)...$(NC)"
	@if [ -d flower/framework ]; then \
		echo "$(YELLOW)  Found Flower framework. Setting up environment...$(NC)"; \
		cd flower && ./dev/setup-envs.sh || true; \
		echo "$(YELLOW)  Note: Flower framework setup is optional. Install it manually if needed:$(NC)"; \
		echo "$(YELLOW)  cd flower/framework && pip install -e .$(NC)"; \
	else \
		echo "$(YELLOW)  Flower framework not found. Skipping...$(NC)"; \
	fi
	@echo "$(GREEN)✓ Setup complete!$(NC)"

# Install dependencies
install:
	bun install

# Build frontend
build:
	bun run build

# Build desktop app
build-desktop:
	bun install
	bun tauri build

# Build desktop app with specific target
build-desktop-target:
	bun install
	bun tauri build --target $(TARGET)

# Build desktop app with bundles and target
build-desktop-full:
	bun install
	bun tauri build --bundles $(BUNDLES) --target $(TARGET)

# Build Android app
build-android:
	bun install
	bun tauri android build

# Build iOS app
build-ios:
	bun install
	bun tauri ios build --export-method app-store-connect

# Clean build artifacts
clean:
	- rm -rf dist src-tauri/target node_modules flower/intelligence/ts/node_modules flower/intelligence/ts/dist public/flower
	- (cd src-tauri && cargo clean)

# Linting
lint:
	bun run lint

lint-fix:
	bun run lint:fix

# Formatting
format:
	bun run format

format-check:
	bun run format-check

# Type checking
type-check:
	bun run type-check

# Run tests
test:
	@echo "$(BLUE)→ Running frontend tests...$(NC)"
	@bun test || echo "$(YELLOW)  No frontend tests found$(NC)"
	@echo "$(BLUE)→ Running backend tests...$(NC)"
	@cd backend && uv run pytest -v

# Run all checks
check:
	bun run check

# Start development servers (backend and frontend)
run:
	@echo "$(BLUE)→ Starting backend and frontend development servers...$(NC)"
	@echo "$(YELLOW)  Backend will run on http://localhost:8000$(NC)"
	@echo "$(YELLOW)  Frontend will run on http://localhost:5173$(NC)"
	@echo "$(YELLOW)  Press Ctrl+C to stop both servers$(NC)"
	@echo ""
	@# Kill any existing processes on the ports first
	@-lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@-lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@# Start backend in background and frontend in foreground
	cd backend && uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000 & \
	BACKEND_PID=$$!; \
	echo "$(GREEN)✓ Backend started (PID: $$BACKEND_PID)$(NC)"; \
	sleep 2; \
	bun run dev || (kill $$BACKEND_PID 2>/dev/null && exit 1)

# Alias for run
dev: run