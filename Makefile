.PHONY: help setup install build build-desktop build-android build-ios clean

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
	bun run test

# Run all checks
check:
	bun run check