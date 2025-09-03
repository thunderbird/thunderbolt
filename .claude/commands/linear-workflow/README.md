# Linear Workflow Commands

This directory contains custom commands for interacting with Linear using the `linctl` CLI tool.

## Quick Start

### Automated Setup (Recommended)
```bash
./setup-linear-workflow-linctl.sh
```
This interactive script will:
- Detect your shell type (bash/zsh/fish)
- Offer global or project-specific installation
- Guide you through authentication setup
- Configure the `lw` alias for your shell

### Manual Installation

#### 1. Install linctl
**Recommended: Build from source** (homebrew version has known bugs)
```bash
git clone https://github.com/dorkitude/linctl.git
cd linctl
make deps        # Install dependencies
make build       # Build the binary
make install     # Install to /usr/local/bin (requires sudo)
```

**Alternative: Homebrew** (may have bugs)
```bash
brew tap dorkitude/linctl
brew install linctl
```

#### 2. Authenticate with Linear
```bash
linctl auth
```
Follow the prompts to enter your Linear API key.

#### 3. Choose Installation Method

**Option A: Global Installation (Recommended)**
```bash
# Copy script to global location
mkdir -p ~/.local/bin
cp linear-workflow.sh ~/.local/bin/linear-workflow
chmod +x ~/.local/bin/linear-workflow

# Add alias to your shell config
echo "alias lw='linear-workflow'" >> ~/.aliases  # or your preferred config file
```

**Option B: Project-Specific Alias**
```bash
# Add alias pointing to this project
echo "alias lw='/path/to/this/project/.claude/commands/linear-workflow/linear-workflow.sh'" >> ~/.aliases
```

## Shell-Specific Setup

### Bash
Add to `~/.bashrc`, `~/.bash_aliases`, or `~/.profile`:
```bash
alias lw='linear-workflow'  # if using global install
# OR
alias lw='/path/to/linear-workflow.sh'  # if using project path
```

### Zsh
Add to `~/.zshrc`, `~/.aliases`, or `~/.oh-my-zsh/custom/aliases.zsh`:
```bash
alias lw='linear-workflow'  # if using global install
# OR  
alias lw='/path/to/linear-workflow.sh'  # if using project path
```

If using `ZDOTDIR`, add to `$ZDOTDIR/.aliases`:
```bash
alias lw='linear-workflow'
```

### Fish
Add to `~/.config/fish/config.fish`:
```fish
function lw
    linear-workflow $argv
end
```

Or create `~/.config/fish/functions/lw.fish`:
```fish
function lw
    linear-workflow $argv
end
```

### Reload Your Shell
After adding the alias:
```bash
source ~/.bashrc    # for bash
source ~/.zshrc     # for zsh  
source ~/.config/fish/config.fish  # for fish
# OR restart your terminal
```

## Usage

After setting up the alias, you can use the `lw` command:

### Available Commands

```bash
# Show all your assigned issues
lw my-issues

# Get detailed issue information with comments
lw get TOT-123

# Show issues updated today
lw today

# Show current sprint issues (last 2 weeks)
lw sprint

# Create a new bug issue
lw create-bug "Login button not working"

# Create a new feature issue
lw create-feature "Add dark mode support"

# Update issue status
lw update-status TOT-123 "In Progress"

# Add a quick comment to an issue
lw quick-comment TOT-123 "Started working on this"

# Show team status overview
lw team-status

# Generate daily standup report
lw standup

# Show help
lw help
```

## Command Details

### `my-issues`
Shows all issues assigned to you, organized by:
- 🚨 Urgent Issues (Priority 1)
- 🔧 In Progress
- 📋 Todo (limited to 10)

### `get`
Shows detailed information about a specific issue:
- Full issue details including description, assignee, state, priority
- Git branch information if linked
- Recent comments (last 5)
- Quick action reminders for common next steps
- Filters out known linctl panic errors for cleaner output

### `standup`
Generates a daily standup report showing:
- Yesterday's completed work
- Today's in-progress items
- Blocked issues
- High priority todos

### `create-bug` and `create-feature`
Creates new issues with pre-formatted templates:
- Automatically assigns to you
- Sets appropriate priority
- Includes structured description template
- Assigns to TOT team

### `team-status`
Provides overview of:
- All teams in workspace
- Tot Squad team details
- Team member list with roles

## Direct linctl Usage

You can also use `linctl` directly for more advanced operations:

```bash
# List all issues with JSON output (for scripting)
linctl issue list --json

# Get specific issue details
linctl issue get TOT-123

# List comments on an issue
linctl comment list TOT-123

# See all available commands
linctl docs
```

## Usage with Claude Code / AI Agents

### Global Installation Benefits
If you've installed globally, Claude Code and other AI agents can easily access the command:

```bash
# Claude Code can run commands like:
linear-workflow my-issues
linear-workflow get TOT-123
linear-workflow standup
```

### Project-Specific Access
For project-specific setups, agents can use the relative path:

```bash
# Claude Code can run commands like:
./.claude/commands/linear-workflow/linear-workflow.sh my-issues
./.claude/commands/linear-workflow/linear-workflow.sh get TOT-123
./.claude/commands/linear-workflow/linear-workflow.sh standup
```

### Automated Workflows
This enables automated workflows where Claude Code can:
- Check your current issues and pick one to work on
- Update issue status as work progresses
- Add comments to document changes
- Create new issues for bugs found during development
- Generate standup reports

### Cross-Platform Compatibility
The global installation approach (`~/.local/bin`) works across different:
- Operating systems (Linux, macOS, WSL)
- Shell types (bash, zsh, fish)
- Development environments
- CI/CD systems that respect standard PATH locations

## Known Issues

### linctl panic errors
The underlying `linctl` tool has known bugs that cause panic errors on some operations (particularly `issue get`). The workflow script filters out these errors to provide cleaner output. The tool still returns the correct data despite the panics.

### JSON parsing errors
Some `jq` parsing errors may appear in the standup report - these are suppressed in the output but don't affect functionality.

## Notes

- The default team for new issues is "TOT" (Tot Squad)
- Authentication credentials are stored in `~/.linctl-auth.json`
- By default, list commands show items from the last 6 months
- Use `--newer-than all_time` with linctl to see all historical data
- The `lw` alias only works in your terminal after sourcing aliases, not in Claude Code's bash environment (unless using global installation)