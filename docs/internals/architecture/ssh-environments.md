# SSH environments

SSH is an execution environment for the built-in agent: the app continues to
orchestrate model calls and approvals, while file operations and shell commands
run on the selected SSH host. It is not a second agent, a cloud-agent service, or
a copy of the remote filesystem on the client.

## Configuration and project identity

Settings owns the connection library. A connection has a stable ID, display
name, SSH host/config alias, optional username and port, and a remote working
directory. Authentication can use the existing SSH configuration and agent, a
selected private-key file (with an optional passphrase), or a password. Private
key files stay in place. Passwords and passphrases are stored only in the OS
credential vault, never in synced settings or the connection-definition store.

The add dialog discovers literal SSH aliases (including config includes), OrbStack
machines, local Tart VMs, and local Docker containers with published SSH ports.
Users select connections to add, with manual entry always available. Discovery
does not authenticate, scan the network, or start machines. Stopped VMs remain
visible but cannot be selected until started. Docker inventories are queried only
for local Unix-socket or Windows named-pipe contexts, never remote Docker hosts.

Connection definitions are device-local. A project's immutable environment
declaration stores the SSH connection ID in the same encrypted, synced settings
mechanism as its other environment choices. The project cannot silently switch
to another connection, the local computer, or the sandbox when its connection
is unavailable. Removing a definition leaves the project bound to the missing
ID; adding a different connection with the same name does not substitute it.
Standalone chats can select an SSH environment independently.

Approvals remain device-local and use the existing Ask/Full access policy. A
remote working directory is a starting directory, not a security sandbox: the
agent acts with the remote account's permissions. Remote files persist after a
conversation ends. Publishing an HTML file captures an artifact through the
normal page tools; it does not synchronize the rest of the remote workspace.

## Transport and status

The desktop shell invokes the system OpenSSH client directly, without a local
shell. Existing SSH aliases support identity agents, jump hosts and configuration
includes without implementing another SSH configuration parser. This follows
the established [Remote SSH host configuration pattern](https://code.visualstudio.com/docs/remote/ssh#_remember-hosts-and-advanced-settings).

Connection probes authenticate and check the remote working directory and
required runtimes. A successful probe produces the green status; a failed probe
produces red with its diagnostic. Available connections are checked automatically
when their status is first shown, with a shared 60-second freshness window.
The last verified result is saved locally with its connection fingerprint and
check time, so refreshing Thunderbolt does not erase it. Credentials and error
messages are never included in that status record. A stale restored result is
rechecked when mounted; a previously verified green result remains visible while
that check runs. A new, unverified connection shows a neutral checking indicator.

Successful agent and folder-browsing requests also refresh the connected status;
SSH transport failures mark it disconnected. Connection changes cannot inherit
another target's health, and working-folder or credential edits clear the saved
result and reset only that connection's query. Users can explicitly refresh a
check at any time. There is no periodic authentication loop, window-focus probe,
or reconnect-triggered probe. Verification may involve the system credential
vault or SSH agent, which can request approval. The indicator describes the last
verified observation, not a persistent SSH session or a guarantee that the next
command will succeed; each operation handles its own transport errors.

Remote folder browsing uses the same structured SSH transport. The helper lists
directories, including hidden folders and directory symlinks, with their literal
names and absolute paths; files and broken symlinks are excluded. Navigating a
directory symlink resolves its destination, and the filesystem root has no
parent entry. Paths travel in JSON and are never interpolated into a shell
command. The project settings show the fixed environment and its working folder
without allowing the project's environment identity to change.

The transport uses strict host-key checking. Before adding a new host, connect
to it in a terminal and verify its fingerprint. Unknown or changed host keys
fail instead of being accepted automatically. OpenSSH documents the relevant
behavior in [`BatchMode` and `StrictHostKeyChecking`](https://man.openbsd.org/ssh_config).
Agent authentication stays in batch mode. Password or encrypted-key
authentication uses an owned askpass helper only when a matching saved secret
exists. It never answers host-key confirmations, verification-code prompts, or
other interactive challenges.

The credential is bound to the connection ID, host, port, username, authentication
method and key path. Changing that target requires entering the secret again.
[`keyring`'s native stores](https://docs.rs/keyring/4.2.0/keyring/v1/index.html)
provide macOS Keychain, Windows Credential Manager and Linux Secret Service.
Windows entries explicitly use local-machine persistence instead of the
backend's roaming default. An unavailable store produces an error without a
plaintext fallback. A locked store may display the operating system's unlock
prompt. A timeout bounds how long the app waits, but cannot dismiss an OS prompt
or cancel a credential-store call that is already running on a worker thread.
A shared nonblocking lock stays with that worker until the OS call returns;
retries fail as busy rather than opening additional unlock prompts.
The askpass helper reuses the desktop executable in an early mode that does not
initialize the GUI. A random one-use token authorizes a bounded loopback
exchange. Only that token and endpoint are placed in the child environment;
the password is never written to command arguments, environment variables or
temporary files. The channel expires after 30 seconds and closes with its SSH
operation. Temporary secret buffers are zeroized when released.
Linux password storage requires an available, unlocked Secret Service such as
GNOME Keyring or KDE Wallet; SSH-agent and unencrypted-key authentication do not
require that service. The zbus backend uses Rust cryptography and introduces no
libsecret build dependency. See the [backend's Linux requirements](https://docs.rs/zbus-secret-service-keyring-store/latest/zbus_secret_service_keyring_store/).

A small bundled Python helper executes on the remote host for structured file
operations and command supervision. Requests travel as JSON over standard
input; paths, file content and commands are not interpolated into the SSH
bootstrap command. The helper runs Bash with the requested working directory
and environment, bounds command duration and captured output, and supervises
the command's process group. Stop closes the request channel and terminates
the local SSH process; the remote helper must also respond to channel loss and
its own deadline. Killing a local SSH process alone is not remote process
containment. The desktop sends a heartbeat every two seconds; after twelve
seconds without one, the remote supervisor stops its command. Group cleanup
covers the shell and ordinary children, while deliberately daemonized or
reparented processes can escape it. This is host access, not OS isolation. No
tool operation is automatically replayed after a lost response: it may already
have modified the remote system.

Only the trusted desktop main webview can invoke this transport. Guest browser
pages and HTML artifacts receive no SSH IPC capability. Identity cleanup closes
owned transports and clears device grants. Cleanup may remove only temporary
files created and recorded by Thunderbolt, never arbitrary remote paths supplied
by a model or a saved setting. Removing or changing a connection forgets its
old output-file ownership without reconnecting to the revoked target; temporary
remote logs can therefore remain when cleanup is no longer authorized or the
host is unavailable.

## Supported hosts and limits

- **Client:** desktop macOS, Linux, and Windows with an OpenSSH client installed.
  Microsoft provides [OpenSSH as a Windows feature](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview).
  Web and mobile do not expose this desktop transport.
- **Remote:** a POSIX host with Bash and Python 3. Windows clients can connect to
  these hosts; this does not imply support for Windows remote shells.
- **OrbStack:** use its existing `orb` SSH config alias. Its username selects a
  machine, including forms such as `user@machine`; keep this separate from the
  hostname. OrbStack provides its own key and normally listens only on the
  Mac's loopback interface. See [OrbStack SSH access](https://docs.orbstack.dev/machines/ssh).
- **Tart:** run the VM, enable SSH, configure its authentication, and use its IP
  or a user-maintained SSH alias. The application does not start VMs or evaluate
  a `tart ip` shell expression entered as a hostname. See [Tart SSH access](https://tart.run/quick-start/#ssh-access).
- **Docker:** connect to an SSH-enabled container or to a host on which the
  account can operate Docker. Docker's `ssh://` daemon connection accesses the
  Docker API, not an arbitrary container shell; it is a different transport.
  See [Docker's SSH connection documentation](https://docs.docker.com/engine/security/protect-access/).

There is no automatic VM/container provisioning, interactive MFA, remote desktop
control, or remote preview port forwarding in this feature.
`local_app` remains a local-computer capability. A remote server's `localhost`
is not the desktop's `localhost`, so a remote server URL must not be opened as
though it were local. Port forwarding can be added as an explicit owned page
capability later.

## Relationship to cloud agents

The Cloud Agent Architecture discussion separates orchestration from execution:
one Bun service owns durable agent runs, while a future VM supplies a real shell
and workspace. SSH fits that boundary through the same coding-environment
interface as the sandbox and local computer. It does not move model credentials,
MCP authorizations, or agent orchestration onto the SSH host.

A future cloud runtime needs its own reachable connection and independently
authorized credentials. It must not borrow a laptop's SSH agent, private keys,
or localhost aliases. The desktop SSH adapter therefore introduces no backend
SSH proxy or new cloud grant system. Project identity, explicit artifact
publication, and the rule against replaying uncertain external actions remain
the same when another execution transport is added.

## Validation

The native workspace suites run on Linux and Windows in CI. The remote Python
helper's filesystem and process tests run on POSIX hosts; transport validation,
credential matching and askpass tests also run on Windows. Python helper changes
participate in the native CI path filter.

`scripts/ssh-askpass-smoke.py` launches the built desktop executable with an
inherited output pipe and a disposable loopback authentication fixture. Windows
CI builds that executable with its release GUI subsystem enabled, so silently
discarded stdout cannot hide behind a successful debug-console test. The
explicitly ignored `system_vault_round_trip` test uses a separate, randomly named
CI credential namespace and removes its entry. CI invokes it against Windows
Credential Manager and an isolated Linux D-Bus/Secret Service session; ordinary
local tests do not access the user's actual vault.
