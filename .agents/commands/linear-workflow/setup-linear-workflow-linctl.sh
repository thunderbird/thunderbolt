#!/bin/bash

# Setup script for Linear workflow command - supports multiple installation methods

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

echo "Setting up Linear workflow alias..."

# Check if linctl is installed
check_linctl() {
    if ! command -v linctl &> /dev/null; then
        print_error "linctl is not installed!"
        echo ""
        echo "Please install linctl first by following these steps:"
        echo ""
        echo "📖 Building from source (recommended due to homebrew version having bugs):"
        echo "   git clone https://github.com/dorkitude/linctl.git"
        echo "   cd linctl"
        echo "   make deps        # Install dependencies"
        echo "   make build       # Build the binary"
        echo "   make install     # Install to /usr/local/bin (requires sudo)"
        echo ""
        echo "🍺 Alternative (Homebrew - may have bugs):"
        echo "   brew tap dorkitude/linctl"
        echo "   brew install linctl"
        echo ""
        echo "After installation, authenticate with Linear:"
        echo "   linctl auth"
        echo ""
        echo "See README.md for more details."
        exit 1
    fi
    print_success "linctl is installed"
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

# Detect shell type
detect_shell() {
    local shell_name=$(basename "$SHELL")
    case "$shell_name" in
        bash) echo "bash";;
        zsh) echo "zsh";;
        fish) echo "fish";;
        *) echo "unknown";;
    esac
}

# Get shell-specific config file suggestions
get_shell_config_suggestions() {
    local shell_type=$1
    case "$shell_type" in
        bash)
            echo "~/.bashrc ~/.bash_aliases ~/.profile"
            ;;
        zsh)
            echo "${ZDOTDIR:-$HOME}/.aliases ~/.zshrc ~/.oh-my-zsh/custom/aliases.zsh"
            ;;
        fish)
            echo "~/.config/fish/config.fish ~/.config/fish/functions/"
            ;;
        *)
            echo "~/.profile ~/.bashrc"
            ;;
    esac
}

# Check linctl installation first
check_linctl

# Detect user's shell
SHELL_TYPE=$(detect_shell)
print_info "Detected shell: $SHELL_TYPE"

# Ask about installation method
echo ""
print_info "Choose installation method:"
echo "  1) Global installation (recommended) - Install to ~/.local/bin with alias"
echo "  2) Project-specific alias - Create alias pointing to this project"
echo "  3) Manual - Show instructions for manual setup"
echo ""
echo -n "Choose option [1-3]: "
read -r install_choice

case "$install_choice" in
    1)
        print_info "Setting up global installation..."
        
        # Create ~/.local/bin if it doesn't exist
        mkdir -p "$HOME/.local/bin"
        
        # Get script path
        DEFAULT_SCRIPT_PATH="./linear-workflow.sh"
        SCRIPT_PATH=$(get_input "Enter the path to linear-workflow.sh" "$DEFAULT_SCRIPT_PATH")
        
        # Convert to absolute path if it's relative
        if [[ "$SCRIPT_PATH" != /* ]]; then
            SCRIPT_PATH="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)/$(basename "$SCRIPT_PATH")"
        fi
        
        # Check if the script exists
        if [[ ! -f "$SCRIPT_PATH" ]]; then
            print_error "Script not found at: $SCRIPT_PATH"
            exit 1
        fi
        
        # Copy to global location
        cp "$SCRIPT_PATH" "$HOME/.local/bin/linear-workflow"
        chmod +x "$HOME/.local/bin/linear-workflow"
        print_success "Installed linear-workflow to ~/.local/bin/"
        
        # Set up alias
        GLOBAL_SCRIPT_PATH="linear-workflow"
        ;;
    2)
        print_info "Setting up project-specific alias..."
        
        # Get script path from user
        DEFAULT_SCRIPT_PATH="./linear-workflow.sh"
        SCRIPT_PATH=$(get_input "Enter the path to linear-workflow.sh" "$DEFAULT_SCRIPT_PATH")
        
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
        GLOBAL_SCRIPT_PATH="$SCRIPT_PATH"
        ;;
    3)
        print_info "Manual installation instructions:"
        echo ""
        echo "1. Copy the script to a global location (optional):"
        echo "   mkdir -p ~/.local/bin"
        echo "   cp ./linear-workflow.sh ~/.local/bin/linear-workflow"
        echo "   chmod +x ~/.local/bin/linear-workflow"
        echo ""
        echo "2. Add alias to your shell config file:"
        
        SUGGESTIONS=$(get_shell_config_suggestions "$SHELL_TYPE")
        echo "   Common config files for $SHELL_TYPE: $SUGGESTIONS"
        echo ""
        echo "   Add this line to your chosen config file:"
        echo "   alias lw='linear-workflow'  # if using global install"
        echo "   alias lw='/path/to/linear-workflow.sh'  # if using direct path"
        echo ""
        echo "3. Reload your shell:"
        echo "   source /path/to/your/config/file"
        echo "   # OR restart your terminal"
        exit 0
        ;;
    *)
        print_error "Invalid choice. Exiting."
        exit 1
        ;;
esac

# Get aliases file from user with shell-specific suggestions
echo ""
SUGGESTIONS=$(get_shell_config_suggestions "$SHELL_TYPE")
print_info "Suggested config files for $SHELL_TYPE: $SUGGESTIONS"

if [[ "$SHELL_TYPE" == "zsh" && -n "$ZDOTDIR" ]]; then
    DEFAULT_ALIASES_FILE="$ZDOTDIR/.aliases"
elif [[ "$SHELL_TYPE" == "fish" ]]; then
    DEFAULT_ALIASES_FILE="$HOME/.config/fish/config.fish"
elif [[ "$SHELL_TYPE" == "bash" ]]; then
    DEFAULT_ALIASES_FILE="$HOME/.bash_aliases"
else
    DEFAULT_ALIASES_FILE="$HOME/.aliases"
fi

ALIASES_FILE=$(get_input "Enter the path to your shell config/aliases file" "$DEFAULT_ALIASES_FILE")

# Create aliases file if it doesn't exist
if [[ ! -f "$ALIASES_FILE" ]]; then
    print_warning "Config file not found. Creating: $ALIASES_FILE"
    mkdir -p "$(dirname "$ALIASES_FILE")"
    touch "$ALIASES_FILE"
fi

ALIAS_NAME="lw"

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

# Add the alias with appropriate syntax for the shell
if [[ "$SHELL_TYPE" == "fish" && "$ALIASES_FILE" == *"functions/"* ]]; then
    # For fish functions directory, create a function file
    FUNCTION_FILE="$ALIASES_FILE/$ALIAS_NAME.fish"
    {
        echo "function $ALIAS_NAME"
        echo "    $GLOBAL_SCRIPT_PATH \$argv"
        echo "end"
    } > "$FUNCTION_FILE"
    print_success "Function '$ALIAS_NAME' created in $FUNCTION_FILE"
elif [[ "$SHELL_TYPE" == "fish" ]]; then
    # For fish config file, use function syntax
    {
        echo ""
        echo "# Linear workflow command"
        echo "function $ALIAS_NAME"
        echo "    $GLOBAL_SCRIPT_PATH \$argv"
        echo "end"
    } >> "$ALIASES_FILE"
    print_success "Function '$ALIAS_NAME' added to $ALIASES_FILE"
else
    # For bash/zsh, use standard alias syntax
    {
        echo ""
        echo "# Linear workflow command"
        echo "alias $ALIAS_NAME='$GLOBAL_SCRIPT_PATH'"
    } >> "$ALIASES_FILE"
    print_success "Alias '$ALIAS_NAME' added to $ALIASES_FILE"
fi

echo ""
print_info "To start using the $ALIAS_NAME command, either:"
if [[ "$SHELL_TYPE" == "fish" ]]; then
    echo "  1. Restart your terminal, or"
    echo "  2. Run: source $ALIASES_FILE"
else
    echo "  1. Restart your terminal, or"
    echo "  2. Run: source $ALIASES_FILE"
fi

if [[ "$install_choice" == "1" ]]; then
    echo ""
    print_info "Global installation complete! The 'linear-workflow' command is now available system-wide."
    echo "You can also use it directly without the alias: linear-workflow help"
fi

echo ""
print_info "Available commands:"
echo "  $ALIAS_NAME help         - Show all available commands"
echo "  $ALIAS_NAME my-issues    - Show your assigned issues"
echo "  $ALIAS_NAME standup      - Generate standup report"
echo "  $ALIAS_NAME today        - Show today's activity"
echo ""
print_success "Setup complete! 🎉"