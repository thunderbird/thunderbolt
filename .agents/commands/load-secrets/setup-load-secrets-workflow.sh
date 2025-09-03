#!/bin/bash

# Setup script to create an alias for the Load Secrets workflow command

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored messages
print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }

echo "Setting up Load Secrets workflow alias..."

# Check if 1Password CLI is installed
check_op_cli() {
    if ! command -v op &> /dev/null; then
        print_error "1Password CLI (op) is not installed!"
        echo ""
        echo "Please install 1Password CLI first by following these steps:"
        echo ""
        echo "🍺 Homebrew:"
        echo "   brew install 1password-cli"
        echo ""
        echo "📦 Direct download:"
        echo "   https://developer.1password.com/docs/cli/get-started/"
        echo ""
        echo "🐧 Linux (snap):"
        echo "   sudo snap install 1password"
        echo ""
        echo "After installation, set up authentication:"
        echo "   op account add       # Add your 1Password account"
        echo "   op signin           # Sign in to your account"
        echo ""
        echo "See README.md for more details."
        exit 1
    fi
    print_success "1Password CLI is installed"
    
    # Check if authenticated (optional - user might want to set up authentication later)
    if ! op account list &>/dev/null; then
        print_warning "1Password CLI is not yet authenticated"
        echo "You'll need to authenticate before using the secrets:"
        echo "   op account add       # If you haven't added an account"
        echo "   op signin           # Sign in to your account"
        echo ""
    else
        print_success "1Password CLI is authenticated"
    fi
}

# Function to get user input with default
get_input() {
    local prompt="$1"
    local default="$2"
    local result
    
    echo -n "$prompt [$default]: "
    read -r result
    echo "${result:-$default}"
}

# Check 1Password CLI installation first
check_op_cli

# Get script path from user
DEFAULT_SCRIPT_PATH="./load-secrets.sh"
SCRIPT_PATH=$(get_input "Enter the path to load-secrets.sh" "$DEFAULT_SCRIPT_PATH")

# Convert to absolute path if it's relative
if [[ "$SCRIPT_PATH" != /* ]]; then
    SCRIPT_PATH="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)/$(basename "$SCRIPT_PATH")"
fi

# Check if the script exists
if [[ ! -f "$SCRIPT_PATH" ]]; then
    print_error "Script not found at: $SCRIPT_PATH"
    exit 1
fi

print_success "Found script at: $SCRIPT_PATH"

# Get aliases file from user
DEFAULT_ALIASES_FILE="${ZDOTDIR:-$HOME}/.aliases"
ALIASES_FILE=$(get_input "Enter the path to your aliases file" "$DEFAULT_ALIASES_FILE")

# Create aliases file if it doesn't exist
if [[ ! -f "$ALIASES_FILE" ]]; then
    print_warning "Aliases file not found. Creating: $ALIASES_FILE"
    mkdir -p "$(dirname "$ALIASES_FILE")"
    touch "$ALIASES_FILE"
fi

ALIAS_NAME="secrets"

# Check if alias already exists
if grep -q "alias $ALIAS_NAME=" "$ALIASES_FILE" 2>/dev/null; then
    print_warning "Alias '$ALIAS_NAME' already exists in $ALIASES_FILE"
    echo "Current alias:"
    grep "alias $ALIAS_NAME=" "$ALIASES_FILE"
    echo ""
    echo -n "Do you want to update it? [y/N]: "
    read -r update_choice
    
    if [[ "$update_choice" =~ ^[Yy]$ ]]; then
        # Remove old alias
        sed -i.bak "/alias $ALIAS_NAME=/d" "$ALIASES_FILE"
        print_info "Removed old alias"
    else
        print_info "Setup cancelled. Existing alias preserved."
        exit 0
    fi
fi

# Add the alias
{
    echo ""
    echo "# Load Secrets workflow command"
    echo "alias $ALIAS_NAME='$SCRIPT_PATH'"
} >> "$ALIASES_FILE"

print_success "Alias '$ALIAS_NAME' added to $ALIASES_FILE"
echo ""
print_info "To start using the alias, either:"
echo "  1. Restart your terminal, or"
echo "  2. Run: source $ALIASES_FILE"
echo ""
print_info "Available commands:"
echo "  $ALIAS_NAME list              - Show available secret sets"
echo "  $ALIAS_NAME load mcp          - Load MCP client secrets"
echo "  $ALIAS_NAME load llm          - Load LLM API keys"
echo "  $ALIAS_NAME show <set>        - Show secrets in a set"
echo "  $ALIAS_NAME validate          - Check all secret references"
echo "  $ALIAS_NAME help              - Show all commands"
echo ""
print_info "Configuration file will be created at:"
echo "  ~/.config/secrets/sets.conf"
echo ""
print_success "Setup complete! 🎉"
echo ""
print_info "Next steps:"
echo "  1. Make sure you're signed into 1Password CLI: op signin"
echo "  2. Run '$ALIAS_NAME list' to see available secret sets"
echo "  3. Run '$ALIAS_NAME load mcp' to load MCP secrets for Claude Code"