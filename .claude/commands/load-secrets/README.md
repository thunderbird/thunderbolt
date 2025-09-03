# Load Secrets Workflow Commands

This directory contains secure environment variable loading using the 1Password CLI (`op`). It provides a safe way to load API keys and other secrets into your environment without storing them in plain text files.

## Setup

1. **Install 1Password CLI** (if not already installed):
   
   **🍺 Homebrew (recommended):**
   ```bash
   brew install 1password-cli
   ```
   
   **📦 Direct download:**
   Visit https://developer.1password.com/docs/cli/get-started/
   
   **🐧 Linux (snap):**
   ```bash
   sudo snap install 1password
   ```

2. **Authenticate with 1Password**:
   ```bash
   op account add       # Add your 1Password account
   op signin           # Sign in to your account
   ```
   
   You can verify authentication with:
   ```bash
   op account list
   ```

3. **Set up the workflow alias**:
   ```bash
   ./setup-load-secrets-workflow.sh
   ```
   This interactive script will:
   - Check if 1Password CLI is installed (with install instructions if not)
   - Prompt for your script and aliases file locations
   - Add the `secrets` alias to your aliases file

## Usage

After setting up the alias, you can use the `secrets` command:

### Available Commands

```bash
# List all available secret sets
secrets list

# Load a predefined secret set
secrets load mcp                    # Load MCP client secrets
secrets load llm                    # Load LLM API keys

# Show what secrets are in a set (without loading them)
secrets show mcp                    # Display MCP secrets configuration

# Test loading secrets (dry run - doesn't actually load)
secrets test mcp                    # Test MCP secrets without loading

# Validate all secret references in config
secrets validate                    # Check that all 1Password references work

# Edit the configuration file
secrets edit                        # Open ~/.config/secrets/sets.conf

# Show help
secrets help
```

### Example Workflow

```bash
# Check what secret sets are available
secrets list

# See what's in the MCP set before loading
secrets show mcp

# Load MCP secrets for Claude Code
secrets load mcp

# Verify secrets were loaded
env | grep -E "CLAUDE_CODE|OPENAI_API_KEY|GITHUB"

# Now run Claude Code with loaded secrets
claude-code
```

## Configuration

The configuration file is located at `~/.config/secrets/sets.conf` and uses INI-style format:

```ini
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

[project]
DATABASE_URL=op://development/postgres/connection_string
API_SECRET=op://development/api/secret_key

[custom]
CUSTOM_VAR=op://vault/item/field
```

### Adding New Secret Sets

1. **Using the edit command:**
   ```bash
   secrets edit
   ```

2. **Manual editing:**
   Edit `~/.config/secrets/sets.conf` and add a new section:
   ```ini
   [my-project]
   DATABASE_PASSWORD=op://development/my-project-db/password
   API_KEY=op://development/my-project-api/credential
   ```

3. **Validate your changes:**
   ```bash
   secrets validate
   ```

### 1Password Reference Format

All secret references use the 1Password CLI format:
- `op://vault/item/field`
- `op://vault/item/credential` (for the main credential field)
- `op://vault/item/password` (for password fields)

Examples:
- `op://Private/GitHub Token/credential`
- `op://engineering/OpenAI API/token`
- `op://development/Database/password`

## Command Details

### `list`
Shows all available secret sets with their contained environment variables.

### `load <set_name>`
Loads all secrets from the specified set into environment variables. The secrets are only available in the current shell session.

### `show <set_name>`
Displays the configuration for a secret set without loading the actual values. Useful for checking what will be loaded.

### `test <set_name>`
Performs a dry run of loading secrets - validates that all references can be accessed but doesn't actually set environment variables.

### `validate`
Checks all secret references in the configuration file to ensure they can be accessed from 1Password. Useful for debugging configuration issues.

### `edit`
Opens the configuration file in your default editor (respects `$EDITOR` environment variable, defaults to `nano` or `vi`).

## Security Features

- **No plain text secrets**: All secrets are stored in 1Password, not in configuration files
- **Session-only**: Loaded secrets are only available in the current shell session
- **Validation**: Built-in validation ensures all secret references are accessible
- **Dry run testing**: Test configurations without actually loading secrets
- **Audit trail**: 1Password logs all access to secrets

## Integration with Claude Code

The MCP secret set is specifically designed for Claude Code usage:

```bash
# Load MCP secrets
secrets load mcp

# Now run Claude Code with all necessary API keys
claude-code
```

The MCP set typically includes:
- `CLAUDE_CODE_RMJ_KEY`: Your Claude API key
- `RMJ_GITHUB_PAT`: GitHub Personal Access Token
- `OPENAI_API_KEY`: OpenAI API key for MCP servers
- `CONTEXT7_API_KEY`: Context7 MCP server key

## Usage with AI Agents

Claude Code and other AI agents can invoke these commands directly:

```bash
# Claude Code can run commands like:
./.claude/commands/load-secrets/load-secrets.sh list
./.claude/commands/load-secrets/load-secrets.sh load mcp
./.claude/commands/load-secrets/load-secrets.sh validate
```

This enables automated workflows where Claude Code can:
- Check available secret sets
- Load necessary API keys before running tasks
- Validate secret configurations
- Securely access external services

## Troubleshooting

### 1Password CLI Issues

**Not authenticated:**
```bash
op signin
```

**Wrong account:**
```bash
op account list
op account use <account-url>
```

**Permission denied:**
```bash
# Make sure you have access to the vault/item
op item list --vault "engineering"
```

### Configuration Issues

**Invalid secret reference:**
```bash
# Use validate to check all references
secrets validate

# Check specific item exists
op item get "item-name" --vault "vault-name"
```

**Environment variables not set:**
```bash
# Check if secrets were actually loaded
env | grep YOUR_VAR_NAME

# Make sure you're in the same shell session where you ran load
```

### Common Errors

1. **"item not found"**: The item name or vault name is incorrect
2. **"permission denied"**: You don't have access to the vault
3. **"not signed in"**: Run `op signin`
4. **"command not found: op"**: Install 1Password CLI

## Notes

- The `secrets` alias only works in your terminal after sourcing aliases, not in Claude Code's bash environment
- Secrets are loaded into the current shell session only - they don't persist across terminal sessions
- Always use `secrets validate` after making configuration changes
- The configuration file is created automatically with sensible defaults when you first run any command
- For security, avoid logging or echoing environment variables that contain secrets

## Best Practices

1. **Regular validation**: Run `secrets validate` periodically to ensure all references work
2. **Minimal access**: Only load the secrets you need for each task
3. **Session isolation**: Use different terminal sessions for different projects
4. **Audit regularly**: Check 1Password's activity log for unexpected access
5. **Test configurations**: Use `secrets test` before `secrets load` for new configurations