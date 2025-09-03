#!/bin/bash

# Load Secrets Workflow Command
# Secure environment variable loading using 1Password CLI

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

# Configuration
CONFIG_DIR="$HOME/.config/secrets"
CONFIG_FILE="$CONFIG_DIR/sets.conf"

# Function to check if 1Password CLI is installed and authenticated
check_op_cli() {
    if ! command -v op &> /dev/null; then
        print_error "1Password CLI (op) is not installed!"
        echo ""
        echo "Please install 1Password CLI first:"
        echo ""
        echo "🍺 Homebrew:"
        echo "   brew install 1password-cli"
        echo ""
        echo "📦 Other platforms:"
        echo "   https://developer.1password.com/docs/cli/get-started/"
        echo ""
        echo "After installation, authenticate with:"
        echo "   op account add"
        echo "   op signin"
        exit 1
    fi

    if ! op account list &>/dev/null; then
        print_error "1Password CLI is not authenticated!"
        echo ""
        echo "Please authenticate with 1Password:"
        echo "   op account add    # If you haven't added an account"
        echo "   op signin         # Sign in to your account"
        exit 1
    fi

    print_success "1Password CLI is ready"
}

# Function to create default config if it doesn't exist
create_default_config() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        print_info "Creating default config at $CONFIG_FILE"
        mkdir -p "$CONFIG_DIR"
        cat > "$CONFIG_FILE" << 'EOF'
# ~/.config/secrets/sets.conf
# Secret sets configuration for load-secrets function

[mcp]
CLAUDE_CODE_RMJ_KEY=op://engineering/zpo5jj7jcspo4aoag76q6njy74/credential
RMJ_GITHUB_PAT=op://engineering/RMJ.PAT.GH.All/token
OPENAI_API_KEY=op://engineering/rmj-aider-openai/credential
CONTEXT7_API_KEY=op://engineering/rs-context7-mcp/credential

[llm]
ANTHROPIC_API_KEY=op://engineering/zpo5jj7jcspo4aoag76q6njy74/credential
OPENAI_API_KEY=op://engineering/rmj-aider-openai/credential

# [project]
# DATABASE_URL=op://development/postgres/connection_string
# API_SECRET=op://development/api/secret_key

# [custom]
# CUSTOM_VAR=op://vault/item/field
EOF
        print_success "Created default config with MCP and LLM secrets"
    fi
}

# Function to show usage
show_help() {
    cat << EOF
Load Secrets Workflow Command - Secure Environment Variable Loading

Usage: $0 <command> [options]

Commands:
    list                Show available secret sets
    load <set_name>     Load predefined secret set
    show <set_name>     Show secrets in a set (without loading)
    create <set_name>   Create a new secret set interactively
    edit                Open config file in editor
    validate            Validate all secret references
    test <set_name>     Test loading a secret set (dry run)

Examples:
    $0 list                    # Show all available secret sets
    $0 load mcp               # Load MCP client secrets
    $0 load llm               # Load LLM API keys
    $0 show mcp               # Show what's in the MCP set
    $0 create project         # Create a new project secret set
    $0 test mcp               # Test MCP secrets without loading
    $0 validate               # Check all secret references

Config File: $CONFIG_FILE

Available Sets:
EOF
    if [[ -f "$CONFIG_FILE" ]]; then
        echo "$(grep '^\[' "$CONFIG_FILE" | sed 's/^\[\([^]]*\)\].*$/    \1/')"
    else
        echo "    (config file not found - run any command to create it)"
    fi
    echo ""
}

# Function to list available secret sets
list_sets() {
    create_default_config
    
    echo -e "\n${BLUE}=== 🔐 Available Secret Sets ===${NC}"
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        print_warning "No config file found"
        return 1
    fi
    
    local current_set=""
    local set_count=0
    
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        
        # Check for section headers
        if [[ "${line:0:1}" == "[" && "${line: -1}" == "]" ]]; then
            local section="${line:1:$((${#line}-2))}"
            section="${section// /}"
            
            if [[ -n "$current_set" ]]; then
                echo ""
            fi
            
            echo -e "${GREEN}📦 $section${NC}"
            current_set="$section"
            ((set_count++))
        elif [[ -n "$current_set" && "$line" =~ ^[^=]+= ]]; then
            local key="${line%%=*}"
            key="${key#"${key%%[![:space:]]*}"}"
            key="${key%"${key##*[![:space:]]}"}"
            echo "    $key"
        fi
    done < "$CONFIG_FILE"
    
    echo ""
    print_success "Found $set_count secret sets"
}

# Function to show secrets in a set without loading them
show_set() {
    local set_name="$1"
    
    if [[ -z "$set_name" ]]; then
        print_error "Set name is required"
        echo "Usage: $0 show <set-name>"
        return 1
    fi
    
    create_default_config
    
    echo -e "\n${BLUE}=== 🔍 Secrets in Set: $set_name ===${NC}"
    
    local in_section=false
    local found_section=false
    local secret_count=0
    
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        
        # Check for section headers
        if [[ "${line:0:1}" == "[" && "${line: -1}" == "]" ]]; then
            local section="${line:1:$((${#line}-2))}"
            section="${section// /}"
            
            if [[ "$section" == "$set_name" ]]; then
                in_section=true
                found_section=true
            else
                in_section=false
            fi
            continue
        fi
        
        # Process key=value pairs in the correct section
        if [[ "$in_section" == true && "$line" =~ ^[^=]+= ]]; then
            local key="${line%%=*}"
            local value="${line#*=}"
            
            # Trim whitespace
            key="${key#"${key%%[![:space:]]*}"}"
            key="${key%"${key##*[![:space:]]}"}"
            value="${value#"${value%%[![:space:]]*}"}"
            value="${value%"${value##*[![:space:]]}"}"
            
            echo "  ${GREEN}$key${NC} ← $value"
            ((secret_count++))
        fi
    done < "$CONFIG_FILE"
    
    if [[ "$found_section" == false ]]; then
        print_error "Secret set '$set_name' not found"
        echo "Available sets:"
        grep '^\[' "$CONFIG_FILE" | sed 's/^\[\([^]]*\)\].*$/  \1/'
        return 1
    fi
    
    print_success "Found $secret_count secrets in set '$set_name'"
}

# Function to safely fetch a single secret
fetch_secret() {
    local secret_ref="$1"
    local env_var="$2"
    local dry_run="${3:-false}"

    if [[ "$dry_run" == "true" ]]; then
        echo "✓ [DRY RUN] Would load $env_var from $secret_ref"
        return 0
    fi

    local secret_value
    if ! secret_value=$(op read "$secret_ref" 2>&1); then
        print_error "Failed to fetch $env_var from 1Password: $secret_ref"
        echo "1Password error: $secret_value" >&2
        return 1
    fi

    export "$env_var=$secret_value"
    print_success "Loaded $env_var"
}

# Function to load secrets from a set
load_secret_set() {
    local set_name="$1"
    local dry_run="${2:-false}"
    
    if [[ -z "$set_name" ]]; then
        print_error "Set name is required"
        echo "Usage: $0 load <set-name>"
        return 1
    fi
    
    create_default_config
    check_op_cli
    
    if [[ "$dry_run" == "true" ]]; then
        echo -e "\n${YELLOW}=== 🧪 Testing Secret Set: $set_name ===${NC}"
    else
        echo -e "\n${BLUE}=== 🔐 Loading Secret Set: $set_name ===${NC}"
    fi
    
    local in_section=false
    local found_section=false
    local loaded_count=0

    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        
        # Check for section headers
        if [[ "${line:0:1}" == "[" && "${line: -1}" == "]" ]]; then
            local section="${line:1:$((${#line}-2))}"
            section="${section// /}"
            
            if [[ "$section" == "$set_name" ]]; then
                in_section=true
                found_section=true
            else
                in_section=false
            fi
            continue
        fi
        
        # Process key=value pairs in the correct section
        if [[ "$in_section" == true && "$line" =~ ^[^=]+= ]]; then
            local key="${line%%=*}"
            local value="${line#*=}"
            
            # Trim whitespace
            key="${key#"${key%%[![:space:]]*}"}"
            key="${key%"${key##*[![:space:]]}"}"
            value="${value#"${value%%[![:space:]]*}"}"
            value="${value%"${value##*[![:space:]]}"}"
            
            if fetch_secret "$value" "$key" "$dry_run"; then
                ((loaded_count++))
            else
                return 1
            fi
        fi
    done < "$CONFIG_FILE"

    if [[ "$found_section" == false ]]; then
        print_error "Secret set '$set_name' not found"
        echo "Available sets:"
        grep '^\[' "$CONFIG_FILE" | sed 's/^\[\([^]]*\)\].*$/  \1/'
        return 1
    fi
    
    if [[ "$dry_run" == "true" ]]; then
        print_success "Test complete: $loaded_count secrets would be loaded from '$set_name'"
    else
        print_success "Loaded $loaded_count secrets from set '$set_name'"
        echo ""
        print_info "Secrets are now available in your current shell session"
        print_info "Run 'env | grep -E \"$(grep -A 20 \"\\[$set_name\\]\" "$CONFIG_FILE" | grep -E '^[A-Z_]+=' | cut -d= -f1 | paste -sd'|' -)\"' to verify"
    fi
}

# Function to validate all secret references
validate_secrets() {
    create_default_config
    check_op_cli
    
    echo -e "\n${BLUE}=== 🔍 Validating All Secret References ===${NC}"
    
    local total_secrets=0
    local valid_secrets=0
    local current_set=""
    
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        
        # Check for section headers
        if [[ "${line:0:1}" == "[" && "${line: -1}" == "]" ]]; then
            current_set="${line:1:-1}"
            current_set="${current_set// /}"
            echo -e "\n${GREEN}📦 Validating set: $current_set${NC}"
            continue
        fi
        
        # Process key=value pairs
        if [[ -n "$current_set" && "$line" =~ ^[^=]+= ]]; then
            local key="${line%%=*}"
            local value="${line#*=}"
            
            # Trim whitespace
            key="${key#"${key%%[![:space:]]*}"}"
            key="${key%"${key##*[![:space:]]}"}"
            value="${value#"${value%%[![:space:]]*}"}"
            value="${value%"${value##*[![:space:]]}"}"
            
            ((total_secrets++))
            
            echo -n "  Checking $key... "
            
            if op read "$value" &>/dev/null; then
                echo -e "${GREEN}✓${NC}"
                ((valid_secrets++))
            else
                echo -e "${RED}✗${NC}"
                print_warning "    Failed to access: $value"
            fi
        fi
    done < "$CONFIG_FILE"
    
    echo ""
    if [[ $valid_secrets -eq $total_secrets ]]; then
        print_success "All $total_secrets secret references are valid"
    else
        print_warning "$valid_secrets of $total_secrets secret references are valid"
        print_error "$(($total_secrets - $valid_secrets)) secrets need attention"
        return 1
    fi
}

# Function to edit config file
edit_config() {
    create_default_config
    
    local editor="${EDITOR:-nano}"
    
    if [[ "$editor" == "nano" ]] && ! command -v nano &> /dev/null; then
        editor="vi"
    fi
    
    print_info "Opening config file with $editor"
    "$editor" "$CONFIG_FILE"
    
    print_success "Config file updated"
    print_info "Run 'validate' to check your changes"
}

# Main command router
case "$1" in
    list)
        list_sets
        ;;
    load)
        load_secret_set "$2"
        ;;
    show)
        show_set "$2"
        ;;
    test)
        load_secret_set "$2" "true"
        ;;
    validate)
        validate_secrets
        ;;
    edit)
        edit_config
        ;;
    help|--help|-h|"")
        show_help
        ;;
    *)
        print_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac