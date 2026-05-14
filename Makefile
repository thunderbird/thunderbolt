.PHONY: help setup setup-symlinks install build build-desktop build-desktop-local build-android build-ios clean run dev dev-desktop dev-ios dev-android dev-android-init doctor doctor-q up down nuke status thunderbot-pull thunderbot-push thunderbot-customize

# Color definitions
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m # No Color

# Container compose tool (auto-detect podman-compose, fallback to docker compose)
COMPOSE ?= $(shell command -v podman-compose > /dev/null 2>&1 && podman info > /dev/null 2>&1 && echo podman-compose || echo docker compose)

# Isolate Docker volumes/networks per clone so sibling working trees (e.g. ~/code/thunderbolt
# and ~/code/some-test-dir/thunderbolt) don't share Postgres data. Defaults to "<parent>-<repo>";
# override with `COMPOSE_PROJECT_NAME=foo make up` if you want a fixed name.
# Sanitize each segment so paths with spaces or other special characters (e.g. "~/My Projects/thunderbolt")
# produce a valid Docker Compose project name.
COMPOSE_PROJECT_NAME ?= $(shell basename "$$(cd .. && pwd)" | sed 's/[^a-zA-Z0-9._-]/-/g')-$(shell basename "$$(pwd)" | sed 's/[^a-zA-Z0-9._-]/-/g')
export COMPOSE_PROJECT_NAME

# Default target
help:
	@echo "Available commands:"
	@echo ""
	@echo "  Setup:"
	@echo "    make setup           - Install frontend + backend dependencies and agent symlinks"
	@echo "    make doctor          - Verify dev tools, env files, and mobile SDKs"
	@echo "    make doctor-q        - Quiet doctor (only prints issues)"
	@echo ""
	@echo "  Containers:"
	@echo "    make up              - Start Postgres + PowerSync containers"
	@echo "    make down            - Stop containers (keeps volumes)"
	@echo "    make nuke            - Wipe all container data and re-init"
	@echo "    make status          - Show container status"
	@echo ""
	@echo "  Dev:"
	@echo "    make dev             - Backend (:8000) + web frontend (:1420)"
	@echo "    make dev-desktop     - Backend + Tauri desktop shell"
	@echo "    make dev-ios         - Backend + Tauri on first booted iOS simulator"
	@echo "    make dev-android     - Backend + Tauri on Android emulator (re-inits gen/android)"
	@echo ""
	@echo "  Build:"
	@echo "    make build           - Vite production build (web)"
	@echo "    make build-desktop   - Tauri desktop release (signed, for CI)"
	@echo "    make build-desktop-local - Tauri desktop release (no updater signing)"
	@echo "    make build-ios       - Tauri iOS release (needs Apple signing certs)"
	@echo "    make build-android   - Tauri Android release"
	@echo "    make clean           - Remove dist, target, node_modules"
	@echo ""
	@echo "  Quality:"
	@echo "    make format          - Format frontend, backend, Rust"
	@echo "    make format-check    - Check formatting"
	@echo ""
	@echo "  Misc:"
	@echo "    make thunderbot-pull       - Pull latest skills from thunderbot"
	@echo "    make thunderbot-push       - Push skill changes back to thunderbot"
	@echo "    make thunderbot-customize  - Fork a thunderbot command (FILE=name.md)"
	@echo "    make setup-symlinks        - Create Claude Code agent symlinks"

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
	bun install
	@echo "$(BLUE)→ Installing backend dependencies...$(NC)"
	cd backend && bun install
	@echo "$(BLUE)→ Installing Playwright browsers (for `make e2e` tests)...$(NC)"
	bunx playwright install
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
	@if command -v cargo > /dev/null 2>&1; then bun run format:rust; else echo "$(YELLOW)⚠ cargo not found, skipping Rust formatting$(NC)"; fi
	@echo "$(GREEN)✓ Formatting complete!$(NC)"

format-check:
	@echo "$(BLUE)→ Checking frontend formatting...$(NC)"
	bun run format-check
	@echo "$(BLUE)→ Checking backend formatting...$(NC)"
	cd backend && bun run format-check
	@echo "$(BLUE)→ Checking Rust formatting...$(NC)"
	@if command -v cargo > /dev/null 2>&1; then bun run format:rust-check; else echo "$(YELLOW)⚠ cargo not found, skipping Rust format check$(NC)"; fi
	@echo "$(GREEN)✓ Format check complete!$(NC)"

# Type checking
type-check:
	bun run type-check

# Run tests
test:
	@echo "$(BLUE)→ Running frontend tests...$(NC)"
	@bun run test
	@echo "$(BLUE)→ Running backend tests...$(NC)"
	@bun run test:backend

# Run all checks
check:
	bun run check

# Start development servers (backend and frontend)
run:
	@echo "$(BLUE)→ Starting backend and frontend development servers...$(NC)"
	@echo "$(YELLOW)  Backend will run on http://localhost:8000$(NC)"
	@echo "$(YELLOW)  Frontend will run on http://localhost:1420$(NC)"
	@echo "$(YELLOW)  Press Ctrl+C to stop both servers$(NC)"
	@echo ""
	@# Kill any existing processes on the ports first
	@-lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@-lsof -ti:1420 | xargs kill -9 2>/dev/null || true
	@# Start backend in background and frontend in foreground
	cd backend && bun run dev & \
	BACKEND_PID=$$!; \
	echo "$(GREEN)✓ Backend started (PID: $$BACKEND_PID)$(NC)"; \
	sleep 2; \
	bun run dev || (kill $$BACKEND_PID 2>/dev/null && exit 1)

# Alias for run
dev: run

# Tauri desktop dev — starts backend (only — Tauri brings its own Vite) + opens the Tauri shell.
# Avoids the :1420 collision you'd get from running `make run` + `bun tauri:dev:desktop` together.
dev-desktop:
	@echo "$(BLUE)→ Starting backend + Tauri desktop dev...$(NC)"
	@-lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@cd backend && bun run dev & \
	BACKEND_PID=$$!; \
	trap "kill $$BACKEND_PID 2>/dev/null" EXIT; \
	echo "$(GREEN)✓ Backend started (PID: $$BACKEND_PID)$(NC)"; \
	sleep 2; \
	bun tauri:dev:desktop

# Tauri iOS dev on simulator. Picks the first booted simulator to avoid Wi-Fi-paired iPhones
# being auto-selected by `tauri ios dev`.
dev-ios:
	@echo "$(BLUE)→ Starting backend + Tauri iOS simulator dev...$(NC)"
	@-lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@SIM_UDID=$$(xcrun simctl list devices booted 2>/dev/null | grep -oE '\([0-9A-F-]{36}\)' | head -1 | tr -d '()'); \
	if [ -z "$$SIM_UDID" ]; then \
		echo "$(YELLOW)⚠ No booted simulator. Boot one first: open -a Simulator$(NC)"; \
		exit 1; \
	fi; \
	echo "$(GREEN)✓ Targeting simulator $$SIM_UDID$(NC)"; \
	cd backend && bun run dev & \
	BACKEND_PID=$$!; \
	trap "kill $$BACKEND_PID 2>/dev/null" EXIT; \
	sleep 2; \
	bun tauri ios dev --config src-tauri/tauri.dev.conf.json "$$SIM_UDID"

# Tauri Android dev. Re-runs init with the dev config first so the package paths match
# the .dev identifier (the chart's gen/android is committed for the prod identifier).
dev-android-init:
	@echo "$(BLUE)→ Re-initializing Android project for dev identifier...$(NC)"
	@rm -rf src-tauri/gen/android
	@bun tauri android init --config src-tauri/tauri.dev.conf.json

dev-android: dev-android-init
	@echo "$(BLUE)→ Starting backend + Tauri Android dev...$(NC)"
	@-lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@cd backend && bun run dev & \
	BACKEND_PID=$$!; \
	trap "kill $$BACKEND_PID 2>/dev/null" EXIT; \
	sleep 2; \
	bun tauri:dev:android

# Desktop release build that skips updater signing (for local artifact testing).
# Real releases use the CI flow which provides TAURI_SIGNING_PRIVATE_KEY.
build-desktop-local:
	@echo "$(BLUE)→ Building desktop app (no updater bundle)...$(NC)"
	@bun install
	@bun tauri build --bundles app dmg
	@echo "$(GREEN)✓ Built. App: src-tauri/target/release/bundle/macos/Thunderbolt.app$(NC)"

# Environment doctor (use `make doctor-q` for quiet mode — only shows issues)
doctor:
	@bash scripts/thunderdoctor.sh

doctor-q:
	@bash scripts/thunderdoctor.sh --quiet

# Container management
up:
	@echo "$(BLUE)→ Starting containers...$(NC)"
	$(COMPOSE) -f powersync-service/docker-compose.yml up -d
	@echo "$(GREEN)✓ Containers started!$(NC)"

down:
	@echo "$(BLUE)→ Stopping containers...$(NC)"
	$(COMPOSE) -f powersync-service/docker-compose.yml down
	@echo "$(GREEN)✓ Containers stopped!$(NC)"

nuke:
	@bash scripts/docker-nuke.sh

status:
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