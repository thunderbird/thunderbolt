---
name: thunderbot-daemon
description: Control the background thunderbot daemon that automatically picks up and works Linear tasks. Usage: /thunderbot-daemon [start|stop|status]
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Thunderbot Daemon Controller

Manage the background daemon that automatically polls Linear for tasks and works them.

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

# Start daemon in background
nohup bun run .claude/thunderbot/daemon.ts start > ~/.claude/thunderbot/daemon.log 2>&1 &
echo "Daemon started (PID $!)"
echo "Logs: ~/.claude/thunderbot/daemon.log"
echo "State: ~/.claude/thunderbot/daemon.state.json"
```

### stop

Stop the running daemon:

```bash
bun run .claude/thunderbot/daemon.ts stop
```

### status

Show daemon status and recent activity:

```bash
bun run .claude/thunderbot/daemon.ts status
```

## Notes

- The daemon polls Linear every 5 minutes for "Todo" tasks
- Each task is worked by spawning a separate Claude Code process with `/thunderbot <task-id>`
- State is persisted at `~/.claude/thunderbot/daemon.state.json`
- Logs are at `~/.claude/thunderbot/daemon.log`
- The daemon skips tasks it has already completed or assessed as infeasible
