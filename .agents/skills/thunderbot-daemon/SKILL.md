---
name: thunderbot-daemon
description: Start, stop or check the background ThunderBot daemon that polls Linear and works each new task unattended.
disable-model-invocation: true
---

Control the background daemon that polls Linear for tasks and works each one with the `thunderbot` skill. The command is the text after the skill name: `start`, `stop` or `status` (default `status`). Run every command from the repository root.

## Read this before `start`

For each new Linear task, the daemon runs this from the checkout, with no human watching:

```bash
claude --print --dangerously-skip-permissions -p "/thunderbot <task-id>"
```

That is an agent with every permission check turned off. It can run any shell command, read every file the user can, and push with the machine's `gh` and `linear` credentials, while it follows ticket text that anyone with access to the Linear workspace can write.

- **Who**: a core team member who owns the machine and reads the daemon log.
- **Where**: a disposable machine, VM or container that holds no personal data, no production access and no credentials beyond the bot's own.
- **Accounts**: dedicated GitHub and Linear tokens scoped like an outside contributor's, with no push to `main` and no admin rights.
- **Input**: ticket titles, descriptions and comments are untrusted. A ticket can carry instructions aimed at the agent.
- **Agent**: the daemon only drives Claude Code.

Before `start`, show this section to the user and continue only after an explicit yes in this session.

## Commands

### start

```bash
if [ -f ~/.claude/thunderbot/daemon.pid ] && kill -0 "$(cat ~/.claude/thunderbot/daemon.pid)" 2>/dev/null; then
  echo "Daemon already running (PID $(cat ~/.claude/thunderbot/daemon.pid))"
else
  mkdir -p ~/.claude/thunderbot
  nohup bun run scripts/thunderbot/daemon.ts start >> ~/.claude/thunderbot/daemon.log 2>&1 &
  echo "Daemon started (PID $!). Logs: ~/.claude/thunderbot/daemon.log"
fi
```

### stop

```bash
bun run scripts/thunderbot/daemon.ts stop
```

### status

```bash
bun run scripts/thunderbot/daemon.ts status
```

## Behavior

- On start it installs missing prerequisites (`linear`, `gh`, `claude`) with Homebrew.
- It polls Linear every 5 minutes for unstarted tasks and prefers tasks labeled "Good For Bot" (the core team's internal Linear workflow).
- It skips tasks it already completed or assessed as infeasible.
- State: `~/.claude/thunderbot/daemon.state.json`. Logs: `~/.claude/thunderbot/daemon.log`.
