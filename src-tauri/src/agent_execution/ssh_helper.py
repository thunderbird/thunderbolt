# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""One request per SSH channel. The channel lease owns foreground commands."""

import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

FILE_LIMIT = 25 * 1024 * 1024
OUTPUT_LIMIT = 4 * 1024 * 1024
LEASE_SECONDS = 12


def directory(value):
    path = os.path.expanduser(value or "~")
    if not os.path.isabs(path) or not os.path.isdir(path):
        raise ValueError("Choose an existing absolute directory on the SSH host")
    return os.path.realpath(path)


def target(request):
    path = request.get("path")
    if not isinstance(path, str) or not path or "\0" in path:
        raise ValueError("Provide a valid remote file path")
    return os.path.abspath(os.path.join(directory(request["cwd"]), path))


def temporary_directory(owner):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", owner):
        raise ValueError("Invalid output owner")
    root = os.path.join(tempfile.gettempdir(), "thunderbolt-ssh-" + str(os.getuid()))
    path = os.path.join(root, owner)
    for item in (root, path):
        try:
            os.mkdir(item, 0o700)
        except FileExistsError:
            pass
        info = os.lstat(item)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Remote output directory must be private and owned by this user")
    return path


def stop_group(process):
    # The shell starts a fresh session. Killing its group also covers ordinary
    # background children; deliberately daemonized/reparented processes are not
    # an OS sandbox and cannot be contained by SSH alone.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def execute(request, disconnected, heartbeat):
    timeout = request.get("timeout") or 120
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 3600:
        raise ValueError("Command timeout must be between 0 and 3600 seconds")
    command = request.get("command")
    if not isinstance(command, str) or "\0" in command:
        raise ValueError("Provide a valid shell command")
    shell = shutil.which("bash")
    if shell is None:
        raise ValueError("Install bash on the SSH host to run agent commands")
    environment = os.environ.copy()
    environment.update(request.get("env") or {})
    process = subprocess.Popen(
        [shell, "-lc", command], cwd=directory(request["cwd"]), env=environment,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,
    )
    started = time.monotonic()
    output = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = set()
    failure = None
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        try:
            while process.poll() is None:
                now = time.monotonic()
                if disconnected.is_set() or now - heartbeat[0] > LEASE_SECONDS:
                    failure = "aborted"
                    break
                if now - started >= timeout:
                    failure = "timeout"
                    break
                for key, _ in selector.select(0.05):
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    retained = min(len(chunk), OUTPUT_LIMIT - len(output[key.data]))
                    output[key.data].extend(chunk[:retained])
                    if retained < len(chunk):
                        truncated.add(key.data)
        finally:
            stop_group(process)
        # Group members are gone. A detached process may still own the pipe;
        # drain only what is immediately available and never wait for it.
        deadline = time.monotonic() + 0.25
        while selector.get_map() and time.monotonic() < deadline:
            for key, _ in selector.select(0.01):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                retained = min(len(chunk), OUTPUT_LIMIT - len(output[key.data]))
                output[key.data].extend(chunk[:retained])
                if retained < len(chunk):
                    truncated.add(key.data)
    process.stdout.close()
    process.stderr.close()
    result = {name: value.decode("utf-8", "replace") for name, value in output.items()}
    for name in truncated:
        result[name] += "\n[Output exceeded 4 MiB; truncated]"
    result.update(exitCode=-1 if failure else process.returncode, failure=failure)
    return result


def dispatch(request, disconnected, heartbeat):
    if os.name != "posix":
        raise ValueError("SSH environments currently require a Linux or macOS host")
    operation = request["operation"]
    if operation == "probe":
        if shutil.which("bash") is None:
            raise ValueError("Install bash on the SSH host to run agent commands")
        return {"cwd": directory(request.get("cwd")), "platform": sys.platform}
    if operation == "list_directories":
        path = directory(request.get("cwd"))
        parent = os.path.dirname(path)
        with os.scandir(path) as entries:
            folders = [{"name": entry.name, "path": entry.path} for entry in entries if entry.is_dir()]
        folders.sort(key=lambda entry: (entry["name"].casefold(), entry["name"]))
        return {"path": path, "parentPath": parent if parent != path else None, "directories": folders}
    if operation == "exec":
        return execute(request, disconnected, heartbeat)
    if operation == "temp":
        prefix, suffix = request.get("prefix") or "", request.get("suffix") or ""
        if not all(re.fullmatch(r"[A-Za-z0-9_.-]*", part) for part in (prefix, suffix)):
            raise ValueError("Invalid temporary filename")
        fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=temporary_directory(request["owner"]))
        with os.fdopen(fd, "wb") as file:
            info = os.fstat(file.fileno())
            return {"path": path, "device": info.st_dev, "inode": info.st_ino}
    if operation == "cleanup":
        root = temporary_directory(request["owner"])
        for file in request.get("files", []):
            if os.path.dirname(file["path"]) != root:
                raise ValueError("Output file is outside its owner's directory")
            try:
                info = os.lstat(file["path"])
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) == (file["device"], file["inode"]):
                os.unlink(file["path"])
        try:
            os.rmdir(root)
        except OSError:
            pass  # Never remove unrelated files placed in the output directory.
        return None
    path = target(request)
    if operation == "resolve":
        return path
    if operation == "read":
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ValueError("The read tool requires a regular file")
        with os.fdopen(fd, "rb") as file:
            content = file.read(FILE_LIMIT + 1)
            if len(content) > FILE_LIMIT:
                raise ValueError("File exceeds 25 MiB. Use a shell command to read a smaller section.")
            return list(content)
    if operation in ("write", "restore"):
        content = bytes(request.get("content") or [])
        if len(content) > FILE_LIMIT:
            raise ValueError("File exceeds 25 MiB")
        if operation == "restore" and os.path.lexists(path):
            return None
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if operation == "restore":
            with tempfile.NamedTemporaryFile(dir=os.path.dirname(path)) as staged:
                staged.write(content)
                staged.flush()
                try:
                    os.link(staged.name, path)
                except FileExistsError:
                    pass
            return None
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NONBLOCK, 0o666)
        with os.fdopen(fd, "wb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise ValueError("The write tool requires a regular file")
            file.truncate(0)
            file.write(content)
        return None
    raise ValueError("Unknown SSH operation")


def main():
    disconnected = threading.Event()
    heartbeat = [time.monotonic()]

    operation = None

    def interrupt_operation(signum, frame):
        if operation == "exec":
            disconnected.set()
            return
        raise InterruptedError("SSH operation timed out" if signum == signal.SIGALRM else "SSH operation aborted")

    def watch_channel():
        while sys.stdin.buffer.readline():
            heartbeat[0] = time.monotonic()
        disconnected.set()
        if operation != "exec" and os.name == "posix":
            os.kill(os.getpid(), signal.SIGUSR1)

    try:
        request = json.loads(sys.stdin.buffer.readline(128 * 1024 * 1024))
        operation = request["operation"]
        if os.name == "posix":
            signal.signal(signal.SIGTERM, interrupt_operation)
            signal.signal(signal.SIGHUP, interrupt_operation)
        if operation != "exec" and os.name == "posix":
            signal.signal(signal.SIGUSR1, interrupt_operation)
            signal.signal(signal.SIGALRM, interrupt_operation)
            signal.alarm(25)
        threading.Thread(target=watch_channel, daemon=True).start()
        value = dispatch(request, disconnected, heartbeat)
        if os.name == "posix":
            signal.alarm(0)
        result = {"ok": True, "value": value}
    except Exception as error:
        result = {"ok": False, "error": str(error)}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    # A daemon blocked on BufferedReader would otherwise race CPython's stream
    # finalization. No persistent server exists; this request owns the process.
    os._exit(0)


if __name__ == "__main__":
    main()
