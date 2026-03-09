---
description: "Control the background thunderbot daemon"
---

Control the background thunderbot daemon that automatically polls Linear for tasks and works them.

## Parse Command

The command is in `$ARGUMENTS`. Valid commands: `start`, `stop`, `status`.

If `$ARGUMENTS` is empty, default to `status`.

## Commands

### start

Start the daemon in the background:

```bash
# Check if already running
if [ -f ~/.claude/thunderbot/daemon.pid ]; then
  PID=$(cat ~/.claude/thunderbot/daemon.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo "Daemon already running (PID $PID)"
    exit 0
  fi
fi

# Ensure state directory exists
mkdir -p ~/.claude/thunderbot

# Start daemon in background
nohup bun run .thunderbot/daemon.ts start >> ~/.claude/thunderbot/daemon.log 2>&1 &
echo "Daemon started (PID $!)"
echo "Logs: ~/.claude/thunderbot/daemon.log"
echo "State: ~/.claude/thunderbot/daemon.state.json"
```

### stop

Stop the running daemon:

```bash
bun run .thunderbot/daemon.ts stop
```

### status

Show daemon status and recent activity:

```bash
bun run .thunderbot/daemon.ts status
```

## Notes

- The daemon auto-installs missing prerequisites (Linear CLI, GitHub CLI, Claude Code) on start
- The daemon polls Linear every 5 minutes for "unstarted" tasks
- Each task is worked by spawning a separate Claude Code process with `/thunderbot <task-id>`
- State is persisted at `~/.claude/thunderbot/daemon.state.json`
- Logs are at `~/.claude/thunderbot/daemon.log`
- The daemon skips tasks it has already completed or assessed as infeasible
