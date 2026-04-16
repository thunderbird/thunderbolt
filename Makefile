.PHONY: help setup setup-symlinks install build build-desktop build-android build-ios clean run dev doctor doctor-q docker-up docker-down docker-nuke docker-status thunderbot-pull thunderbot-push thunderbot-customize

# Color definitions
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m # No Color
BUN := $(shell if command -v bun >/dev/null 2>&1; then command -v bun; elif [ -x "$$HOME/.bun/bin/bun" ]; then printf '%s' "$$HOME/.bun/bin/bun"; else printf '%s' bun; fi)

# Default target
help:
	@echo "Available commands:"
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
	@echo "  make docker-nuke    - Destroy all docker data and recreate from scratch"
	@echo "  make docker-status  - Show docker container status"
	@echo "  make thunderbot-pull - Pull latest skills from thunderbot"
	@echo "  make thunderbot-push      - Push skill changes back to thunderbot"
	@echo "  make thunderbot-customize - Fork a thunderbot command for local edits (FILE=name.md)"
	@echo "  make setup-symlinks       - Create agent symlinks for Claude Code"

# Create agent symlinks for Claude Code
setup-symlinks:
	@mkdir -p .claude/commands .claude/agents
	@for f in .thunderbot/thunder*.md; do ln -sf "../../$$f" ".claude/commands/$$(basename $$f)"; done
	@ln -sfn ../../.thunderbot/thunderbot .claude/commands/thunderbot
	@ln -sf ../../.thunderbot/thunderbot.md .claude/agents/thunderbot.md
	@echo "$(GREEN)✓ Agent symlinks configured$(NC)"

# Setup project - install frontend and backend dependencies
setup: setup-symlinks
	@echo "$(BLUE)→ Installing frontend dependencies...$(NC)"
	$(BUN) install
	@echo "$(BLUE)→ Installing backend dependencies...$(NC)"
	cd backend && $(BUN) install
	@echo "$(GREEN)✓ Setup complete!$(NC)"

# Install dependencies
install:
	$(BUN) install

# Build frontend
build:
	$(BUN) run build

# Build desktop app
build-desktop:
	$(BUN) install
	$(BUN) tauri build

# Build desktop app with specific target
build-desktop-target:
	$(BUN) install
	$(BUN) tauri build --target $(TARGET)

# Build desktop app with bundles and target
build-desktop-full:
	$(BUN) install
	$(BUN) tauri build --bundles $(BUNDLES) --target $(TARGET)

# Build Android app
build-android:
	$(BUN) install
	$(BUN) tauri android build

# Build iOS app
build-ios:
	$(BUN) install
	$(BUN) tauri ios build --export-method app-store-connect

# Clean build artifacts
clean:
	- rm -rf dist src-tauri/target node_modules
	- (cd src-tauri && cargo clean)

# Linting
lint:
	$(BUN) run lint

lint-fix:
	$(BUN) run lint:fix

# Formatting
format:
	@echo "$(BLUE)→ Formatting frontend code...$(NC)"
	$(BUN) run format
	@echo "$(BLUE)→ Formatting backend code...$(NC)"
	cd backend && $(BUN) run format
	@echo "$(BLUE)→ Formatting Rust code...$(NC)"
	$(BUN) run format:rust
	@echo "$(GREEN)✓ Formatting complete!$(NC)"

format-check:
	@echo "$(BLUE)→ Checking frontend formatting...$(NC)"
	$(BUN) run format-check
	@echo "$(BLUE)→ Checking backend formatting...$(NC)"
	cd backend && $(BUN) run format-check
	@echo "$(BLUE)→ Checking Rust formatting...$(NC)"
	$(BUN) run format:rust-check
	@echo "$(GREEN)✓ Format check complete!$(NC)"

# Type checking
type-check:
	$(BUN) run type-check

# Run tests
test:
	@echo "$(BLUE)→ Running frontend tests...$(NC)"
	@$(BUN) test || echo "$(YELLOW)  No frontend tests found$(NC)"
	@echo "$(BLUE)→ Running backend tests...$(NC)"
	@cd backend && $(BUN) test

# Run all checks
check:
	$(BUN) run check

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
	cd backend && $(BUN) run dev & \
	BACKEND_PID=$$!; \
	echo "$(GREEN)✓ Backend started (PID: $$BACKEND_PID)$(NC)"; \
	sleep 2; \
	$(BUN) run dev || (kill $$BACKEND_PID 2>/dev/null && exit 1)

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

docker-nuke:
	@bash scripts/docker-nuke.sh

docker-status:
	@bash scripts/docker-status.sh

# Thunderbot skill sync
thunderbot-pull:
	@echo "$(BLUE)→ Pulling latest skills from thunderbot...$(NC)"
	git subtree pull --prefix=.thunderbot thunderbot main --squash
	@$(MAKE) setup-symlinks
	@echo "$(GREEN)✓ Skills updated!$(NC)"

thunderbot-push:
	@echo "$(BLUE)→ Pushing skill changes to thunderbot...$(NC)"
	git subtree push --prefix=.thunderbot thunderbot main
	@echo "$(GREEN)✓ Skills pushed!$(NC)"

thunderbot-customize:
	@if [ -z "$(FILE)" ]; then echo "Usage: make thunderbot-customize FILE=thunderfix.md"; exit 1; fi
	@if [ ! -L ".claude/commands/$(FILE)" ]; then echo "$(YELLOW).claude/commands/$(FILE) is not a symlink — already customized or doesn't exist$(NC)"; exit 1; fi
	@rm ".claude/commands/$(FILE)" && cp ".thunderbot/$(FILE)" ".claude/commands/$(FILE)"
	@echo "$(GREEN)✓ .claude/commands/$(FILE) is now a local copy — edit freely$(NC)"
