.PHONY: help setup install build build-desktop build-android build-ios clean run dev doctor doctor-q docker-up docker-down docker-status up env-setup db-migrate db-wait

# Color definitions
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m # No Color

# Default target
help:
	@echo "Available commands:"
	@echo "  make up             - Complete dev setup: env files, deps, docker, migrations, and servers"
	@echo "  make setup          - Install frontend and backend dependencies"
	@echo "  make install        - Install frontend dependencies"
	@echo "  make run            - Start both backend and frontend development servers"
	@echo "  make dev            - Alias for 'make run'"
	@echo "  make build          - Build frontend for production"
	@echo "  make build-desktop  - Build Tauri desktop app"
	@echo "  make build-android  - Build Tauri Android app"
	@echo "  make build-ios      - Build Tauri iOS app"
	@echo "  make clean          - Clean build artifacts"
	@echo "  make format         - Format frontend, backend (JS/TS), and Rust code"
	@echo "  make format-check   - Check formatting for frontend, backend, and Rust code"
	@echo "  make doctor         - Verify all dev tools and env files are configured"
	@echo "  make docker-up      - Start docker containers (PowerSync, Mongo, etc.)"
	@echo "  make docker-down    - Stop docker containers"
	@echo "  make docker-status  - Show docker container status"

# Setup project - install frontend and backend dependencies
setup:
	@echo "$(BLUE)→ Installing frontend dependencies...$(NC)"
	bun install
	@echo "$(BLUE)→ Installing backend dependencies...$(NC)"
	cd backend && bun install
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
	- rm -rf dist src-tauri/target node_modules
	- (cd src-tauri && cargo clean)

# Linting
lint:
	bun run lint

lint-fix:
	bun run lint:fix

# Formatting
format:
	@echo "$(BLUE)→ Formatting frontend code...$(NC)"
	bun run format
	@echo "$(BLUE)→ Formatting backend code...$(NC)"
	cd backend && bun run format
	@echo "$(BLUE)→ Formatting Rust code...$(NC)"
	bun run format:rust
	@echo "$(GREEN)✓ Formatting complete!$(NC)"

format-check:
	@echo "$(BLUE)→ Checking frontend formatting...$(NC)"
	bun run format-check
	@echo "$(BLUE)→ Checking backend formatting...$(NC)"
	cd backend && bun run format-check
	@echo "$(BLUE)→ Checking Rust formatting...$(NC)"
	bun run format:rust-check
	@echo "$(GREEN)✓ Format check complete!$(NC)"

# Type checking
type-check:
	bun run type-check

# Run tests
test:
	@echo "$(BLUE)→ Running frontend tests...$(NC)"
	@bun test || echo "$(YELLOW)  No frontend tests found$(NC)"
	@echo "$(BLUE)→ Running backend tests...$(NC)"
	@cd backend && bun test

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
	cd backend && bun run dev & \
	BACKEND_PID=$$!; \
	echo "$(GREEN)✓ Backend started (PID: $$BACKEND_PID)$(NC)"; \
	sleep 2; \
	bun run dev || (kill $$BACKEND_PID 2>/dev/null && exit 1)

# Alias for run
dev: run

# Environment doctor (use `make doctor-q` for quiet mode — only shows issues)
doctor:
	@bash scripts/thunderdoctor.sh

doctor-q:
	@bash scripts/thunderdoctor.sh --quiet

# Docker management
docker-up:
	@echo "$(BLUE)→ Starting docker containers...$(NC)"
	docker compose -f powersync-service/docker-compose.yml up -d
	@echo "$(GREEN)✓ Docker containers started!$(NC)"

docker-down:
	@echo "$(BLUE)→ Stopping docker containers...$(NC)"
	docker compose -f powersync-service/docker-compose.yml down
	@echo "$(GREEN)✓ Docker containers stopped!$(NC)"

docker-status:
	@bash scripts/docker-status.sh

# Complete development environment setup
up: env-setup setup docker-up db-wait db-migrate run

# Copy .env.example files if .env doesn't exist
env-setup:
	@echo "$(BLUE)→ Setting up environment files...$(NC)"
	@if [ ! -f .env ]; then \
		cp .env.example .env && echo "$(GREEN)✓ Created .env from .env.example$(NC)"; \
	else \
		echo "$(YELLOW)  .env already exists, skipping$(NC)"; \
	fi
	@if [ ! -f backend/.env ]; then \
		cp backend/.env.example backend/.env && echo "$(GREEN)✓ Created backend/.env from .env.example$(NC)"; \
	else \
		echo "$(YELLOW)  backend/.env already exists, skipping$(NC)"; \
	fi

# Wait for PostgreSQL to be ready (max 30 seconds)
db-wait:
	@echo "$(BLUE)→ Waiting for PostgreSQL to be ready...$(NC)"
	@for i in $$(seq 1 30); do \
		HEALTH=$$(docker compose -f powersync-service/docker-compose.yml ps postgres --format json 2>/dev/null | grep -o '"Health":"[^"]*"' | cut -d'"' -f4); \
		if [ "$$HEALTH" = "healthy" ]; then \
			echo "$(GREEN)✓ PostgreSQL is ready!$(NC)"; \
			exit 0; \
		fi; \
		echo "$(YELLOW)  Waiting for PostgreSQL... ($$i/30)$(NC)"; \
		sleep 1; \
	done; \
	echo "$(YELLOW)⚠ PostgreSQL did not become ready in 30 seconds$(NC)"; \
	exit 1

# Run backend database migrations
db-migrate:
	@echo "$(BLUE)→ Running database migrations...$(NC)"
	cd backend && bun run db migrate
	@echo "$(GREEN)✓ Database migrations complete!$(NC)"