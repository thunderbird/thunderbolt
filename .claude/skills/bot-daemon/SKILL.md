---
name: bot-daemon
description: Control the background bot daemon that automatically picks up and works Linear tasks. Usage: /bot-daemon [start|stop|status]
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Bot Daemon Controller

Manage the background daemon that automatically polls Linear for tasks and works them.

## Parse Command

The command is in `$ARGUMENTS`. Valid commands: `start`, `stop`, `status`.

If `$ARGUMENTS` is empty, default to `status`.

## Commands

### start

Start the daemon in the background:

```bash
# Check if already running
if [ -f ~/.claude/bot/daemon.pid ]; then
  PID=$(cat ~/.claude/bot/daemon.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo "Daemon already running (PID $PID)"
    exit 0
  fi
fi

# Start daemon in background
nohup bun run .claude/bot/daemon.ts start > ~/.claude/bot/daemon.log 2>&1 &
echo "Daemon started (PID $!)"
echo "Logs: ~/.claude/bot/daemon.log"
echo "State: ~/.claude/bot/daemon.state.json"
```

### stop

Stop the running daemon:

```bash
bun run .claude/bot/daemon.ts stop
```

### status

Show daemon status and recent activity:

```bash
bun run .claude/bot/daemon.ts status
```

## Notes

- The daemon polls Linear every 5 minutes for "Todo" tasks
- Each task is worked by spawning a separate Claude Code process with `/bot <task-id>`
- State is persisted at `~/.claude/bot/daemon.state.json`
- Logs are at `~/.claude/bot/daemon.log`
- The daemon skips tasks it has already completed or assessed as infeasible
