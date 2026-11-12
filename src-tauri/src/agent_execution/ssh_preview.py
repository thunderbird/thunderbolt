# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""App-owned preview; executed after ssh_helper.py's shared definitions."""

import select
import socket


def preview_main():
    disconnected = threading.Event()
    heartbeat = [time.monotonic()]
    process = None
    reservation = None

    def emit(event):
        # A stalled stdout consumer must not prevent the lease from reaping children.
        remaining = memoryview((json.dumps(event, separators=(",", ":")) + "\n").encode())
        deadline = time.monotonic() + LEASE_SECONDS
        while remaining:
            if disconnected.is_set() or time.monotonic() - heartbeat[0] > LEASE_SECONDS or time.monotonic() > deadline:
                disconnected.set()
                return False
            if not select.select([], [sys.stdout.fileno()], [], 0.1)[1]:
                continue
            try:
                remaining = remaining[os.write(sys.stdout.fileno(), remaining):]
            except BlockingIOError:
                continue
            except (BrokenPipeError, OSError):
                disconnected.set()
                return False
        return True

    def watch_channel():
        while sys.stdin.buffer.readline():
            heartbeat[0] = time.monotonic()
        disconnected.set()

    try:
        if os.name != "posix":
            raise ValueError("SSH previews require a Linux or macOS host")
        request = json.loads(sys.stdin.buffer.readline(4 * 1024 * 1024))
        executable = request.get("executable")
        args = request.get("args", [])
        port = request.get("port") or 0
        if not isinstance(executable, str) or not executable.strip() or "\0" in executable:
            raise ValueError("Provide a preview executable")
        if not isinstance(args, list) or len(args) > 100 or any(not isinstance(arg, str) or "\0" in arg or len(arg) > 32768 for arg in args):
            raise ValueError("Provide valid preview arguments")
        if not isinstance(port, int) or not 0 <= port <= 65535:
            raise ValueError("Invalid preview port")
        cwd = directory(request.get("cwd"))
        signal.signal(signal.SIGTERM, lambda *_: disconnected.set())
        signal.signal(signal.SIGHUP, lambda *_: disconnected.set())
        threading.Thread(target=watch_channel, daemon=True).start()
        os.set_blocking(sys.stdout.fileno(), False)
        reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # Permit immediate restarts after HTTP connections enter TIME_WAIT.
        # SO_REUSEADDR still rejects another active listener on this address.
        reservation.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        reservation.bind(("127.0.0.1", port))
        port = reservation.getsockname()[1]
        environment = os.environ.copy()
        environment.update({"PORT": str(port), "HOST": "127.0.0.1"})
        argv = [executable, *[arg.replace("{port}", str(port)) for arg in args]]
        reservation.close()
        reservation = None
        if disconnected.is_set():
            return
        # Approved app argv, passed directly without a shell; the desktop owns its channel lease.
        process = subprocess.Popen(argv, cwd=cwd, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)  # nosemgrep: python.django.security.injection.command.subprocess-injection.subprocess-injection
        if not emit({"event": "started", "port": port}):
            return
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            selector.register(process.stderr, selectors.EVENT_READ)
            while process.poll() is None:
                if disconnected.is_set() or time.monotonic() - heartbeat[0] > LEASE_SECONDS:
                    return
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    elif not emit({"event": "log", "text": chunk.decode("utf-8", "replace")}):
                        return
        emit({"event": "exited", "code": process.returncode})
    except Exception as error:
        # Before stdout becomes nonblocking, this bounded startup error still uses the same wire format.
        os.set_blocking(sys.stdout.fileno(), False)
        emit({"event": "failed", "error": str(error)})
    finally:
        if reservation is not None:
            reservation.close()
        if process is not None:
            stop_group(process)
            process.stdout.close()
            process.stderr.close()
        # Do not race CPython finalization against the blocked daemon stdin reader.
        os._exit(0)
