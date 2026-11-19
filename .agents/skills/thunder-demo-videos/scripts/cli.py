#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Capture a real command’s PTY output as supporting evidence for native recordings."""

import argparse
import codecs
import errno
import fcntl
import json
import math
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import struct
import subprocess
import sys
import termios
import time


def stop_process_group(process):
    """Reap the command and stop descendants even when the session leader exited first."""
    def signal_group(value):
        try:
            os.killpg(process.pid, value)
        except ProcessLookupError:
            pass  # The group may exit between poll/wait and signal delivery.

    signal_group(signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    finally:
        signal_group(signal.SIGKILL)
    return process.wait()


def record(args):
    """Capture a command in the supplied working directory without resetting files or approvals."""
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise ValueError('Supply the real CLI invocation after --')
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        raise ValueError('Timeout must be finite and positive')
    if not all(1 <= value <= 65535 for value in (args.rows, args.columns)):
        raise ValueError('Terminal rows and columns must be from 1 to 65535')
    if args.output.exists():
        raise ValueError('Choose a new capture path; raw recordings are immutable')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.columns, 0, 0))
    environment = dict(os.environ, TERM='xterm-256color', COLUMNS=str(args.columns), LINES=str(args.rows))
    try:
        process = subprocess.Popen(command, cwd=args.cwd, env=environment, stdin=slave, stdout=slave,
                                   stderr=slave, start_new_session=True, close_fds=True)
    except OSError:
        os.close(master)
        raise
    finally:
        os.close(slave)
    start = time.monotonic()
    events = [[0, '❯ ' + shlex.join(command) + '\r\n\r\n']]
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    timed_out = False
    try:
        while True:
            ready, _, _ = select.select([master], [], [], .1)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break  # Linux signals the slave closing with EIO rather than EOF.
                    raise
                if not data:
                    break
                text = decoder.decode(data)
                if text:
                    events.append([round(time.monotonic() - start, 4), text])
                    print(text, end='', flush=True)
            elif process.poll() is not None:
                break
            if time.monotonic() - start > args.timeout:
                timed_out = True
                break
        if not timed_out:
            try:
                process.wait(timeout=max(0, args.timeout - (time.monotonic() - start)))
            except subprocess.TimeoutExpired:
                timed_out = True
    finally:
        os.close(master)
        exit_code = stop_process_group(process)
    tail = decoder.decode(b'', final=True)
    if tail:
        events.append([round(time.monotonic() - start, 4), tail])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as capture:
        capture.write(json.dumps({'version': 1, 'columns': args.columns, 'lines': args.rows,
                                  'command': command, 'events': events, 'exit': exit_code,
                                  'timedOut': timed_out}, indent=2) + '\n')
    return 124 if timed_out else (128 - exit_code if exit_code < 0 else exit_code)


def main():
    """Record evidence after authentication and setup have completed."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='mode', required=True)
    capture = commands.add_parser('record')
    capture.add_argument('--output', type=Path, required=True)
    capture.add_argument('--cwd', type=Path, required=True)
    capture.add_argument('--columns', type=int, default=100)
    capture.add_argument('--rows', type=int, default=28)
    capture.add_argument('--timeout', type=float, default=180)
    capture.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    return record(args)


if __name__ == '__main__':
    sys.exit(main())
